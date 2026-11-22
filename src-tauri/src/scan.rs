//! Measuring folders. Ported from fix-storage `src/core/scan.ts` and `browse.ts`
//! (MIT, (c) 2026 the fix-storage authors): `du -skx` per folder with a watchdog for
//! macOS privacy prompts, `lstat` for loose files, Spotlight's last-used date via `mdls`.
//! Everything here runs locally; nothing is sent anywhere.

use crate::roots::{category_of, mac_roots, CategoryId, Root};
use crate::safety::cannot_remove;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub dir: bool,
    pub category: CategoryId,
    /// Modification time, ms since epoch.
    pub modified_ms: Option<f64>,
    /// Spotlight's kMDItemLastUsedDate, ms since epoch, when macOS knows it.
    pub last_used_ms: Option<f64>,
    /// Why this item can never be moved to the Trash (hard block), if so.
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub items: Vec<ScanItem>,
    /// Folders this process could not read (often needs Full Disk Access).
    pub denied: Vec<String>,
    pub disk: Option<DiskSpace>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    pub total: u64,
    pub available: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "listing" (reading folders; total is 0 = unknown), "measuring" (du per item),
    /// "dates" (Spotlight last-used dates). `done`/`total` count items within the phase.
    pub phase: &'static str,
    pub current: String,
    pub done: usize,
    pub total: usize,
}

pub fn disk_space() -> Option<DiskSpace> {
    for path in ["/System/Volumes/Data", "/"] {
        let c = std::ffi::CString::new(path).ok()?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0 {
            let frsize = s.f_frsize;
            return Some(DiskSpace { total: s.f_blocks as u64 * frsize, available: s.f_bavail as u64 * frsize });
        }
    }
    None
}

struct DuResult {
    bytes: u64,
    denied: bool,
}

fn cpu_time(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "cputime=", "-p", &pid.to_string()]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// `du -skx` for one folder. On macOS a du that used no CPU between two checks
/// 5 s apart is waiting on a privacy prompt: kill it and report the folder unreadable
/// (same rule as fix-storage).
fn du(path: &str, cancel: &AtomicBool) -> DuResult {
    let child = Command::new("du").args(["-skx", path]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let Ok(mut child) = child else { return DuResult { bytes: 0, denied: false } };
    let pid = child.id();
    let watchdog = cfg!(target_os = "macos");
    let mut last_cpu: Option<String> = None;
    let mut last_check = Instant::now();
    let mut stalled = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return DuResult { bytes: 0, denied: false };
        }
        if watchdog && last_check.elapsed() >= Duration::from_secs(5) {
            last_check = Instant::now();
            if let Some(cpu) = cpu_time(pid) {
                if last_cpu.as_deref() == Some(cpu.as_str()) {
                    stalled = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                last_cpu = Some(cpu);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = child.wait_with_output();
    let (stdout, stderr) = match out {
        Ok(o) => (String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string()),
        Err(_) => (String::new(), String::new()),
    };
    let kb: u64 = stdout.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
    DuResult { bytes: kb * 1024, denied: stalled || stderr.contains("not permitted") || stderr.contains("Permission denied") }
}

fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64)
}

/// Parses mdls dates like "2024-03-01 12:34:56 +0000" into ms since epoch (UTC only, which is what mdls prints).
pub fn parse_mdls_date(value: &str) -> Option<f64> {
    let v = value.trim();
    if v.is_empty() || v == "(null)" {
        return None;
    }
    let (date, rest) = v.split_once(' ')?;
    let (time, zone) = rest.split_once(' ').unwrap_or((rest, "+0000"));
    if zone != "+0000" {
        return None;
    }
    let d: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    let t: Vec<i64> = time.split(':').filter_map(|x| x.parse().ok()).collect();
    if d.len() != 3 || t.len() != 3 {
        return None;
    }
    // days from civil (Howard Hinnant)
    let (y, m, day) = (d[0], d[1], d[2]);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + t[0] * 3600 + t[1] * 60 + t[2]) * 1000) as f64)
}

/// Spotlight last-used dates, 40 paths per mdls call, like fix-storage's `usage()`.
fn last_used(paths: &[String], on_progress: &dyn Fn(Progress)) -> Vec<Option<f64>> {
    let mut result = vec![None; paths.len()];
    if !cfg!(target_os = "macos") {
        return result;
    }
    for (chunk_i, batch) in paths.chunks(40).enumerate() {
        on_progress(Progress { phase: "dates", current: batch[0].clone(), done: chunk_i * 40, total: paths.len() });
        let out = Command::new("mdls").args(["-raw", "-name", "kMDItemLastUsedDate"]).args(batch).stderr(Stdio::null()).output();
        let Ok(out) = out else { continue };
        let text = String::from_utf8_lossy(&out.stdout);
        let values: Vec<&str> = text.split('\0').collect();
        if values.len() != batch.len() {
            continue;
        }
        for (j, v) in values.iter().enumerate() {
            result[chunk_i * 40 + j] = parse_mdls_date(v);
        }
    }
    result
}

enum Unit {
    Dir(String),
    File(String, u64),
}

fn holds_root(path: &str, roots: &[Root]) -> bool {
    let prefix = format!("{path}/");
    roots.iter().any(|r| r.path.starts_with(&prefix))
}

/// Collects what to measure. `whole_mac`: every fix-storage root, children measured one by one,
/// nested roots measured on their own so nothing is counted twice. Otherwise: the children of `folder`.
fn collect_units(
    start: &[String],
    roots: &[Root],
    root_paths: &HashSet<String>,
    nested_aware: bool,
    denied: &mut Vec<String>,
    on_progress: &dyn Fn(Progress),
) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut queue: VecDeque<String> = start.iter().cloned().collect();
    while let Some(dir) = queue.pop_front() {
        on_progress(Progress { phase: "listing", current: dir.clone(), done: units.len(), total: 0 });
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    denied.push(dir.clone());
                } else if let Ok(meta) = fs::symlink_metadata(&dir) {
                    if meta.is_file() {
                        units.push(Unit::File(dir.clone(), meta.blocks() * 512));
                    }
                }
                continue;
            }
        };
        for entry in entries.flatten() {
            let child = format!("{}/{}", dir.trim_end_matches('/'), entry.file_name().to_string_lossy());
            if nested_aware && root_paths.contains(&child) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&child) else { continue };
            if meta.is_dir() {
                if nested_aware && holds_root(&child, roots) {
                    queue.push_back(child);
                } else {
                    units.push(Unit::Dir(child));
                }
            } else {
                units.push(Unit::File(child, meta.blocks() * 512));
            }
        }
    }
    units
}

pub struct ScanOptions {
    pub home: String,
    /// None = every fix-storage root on this Mac; Some(path) = the children of one folder.
    pub folder: Option<String>,
    pub min_size: u64,
    pub limit: usize,
}

pub fn run_scan(opts: ScanOptions, cancel: Arc<AtomicBool>, on_progress: impl Fn(Progress) + Send + Sync + 'static) -> ScanResult {
    let on_progress = Arc::new(on_progress);
    let roots = mac_roots(&opts.home);
    let root_paths: HashSet<String> = roots.iter().map(|r| r.path.clone()).collect();
    let mut denied = Vec::new();
    let units = match &opts.folder {
        None => {
            let start: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
            collect_units(&start, &roots, &root_paths, true, &mut denied, &*on_progress)
        }
        Some(folder) => collect_units(std::slice::from_ref(folder), &roots, &root_paths, false, &mut denied, &*on_progress),
    };

    let total = units.len();
    let measured: Arc<Mutex<Vec<(String, u64, bool)>>> = Arc::new(Mutex::new(Vec::with_capacity(total)));
    let denied_m = Arc::new(Mutex::new(denied));
    let queue = Arc::new(Mutex::new(units.into_iter().collect::<VecDeque<_>>()));
    let done = Arc::new(AtomicUsize::new(0));
    on_progress(Progress { phase: "measuring", current: String::new(), done: 0, total });
    let workers = 6;
    let mut handles = Vec::new();
    for _ in 0..workers {
        let (queue, measured, denied_m, done, cancel, on_progress) =
            (queue.clone(), measured.clone(), denied_m.clone(), done.clone(), cancel.clone(), on_progress.clone());
        handles.push(std::thread::spawn(move || loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let next = queue.lock().unwrap().pop_front();
            let Some(unit) = next else { return };
            match unit {
                Unit::File(path, bytes) => measured.lock().unwrap().push((path, bytes, false)),
                Unit::Dir(path) => {
                    on_progress(Progress { phase: "measuring", current: path.clone(), done: done.load(Ordering::Relaxed), total });
                    let r = du(&path, &cancel);
                    if r.denied {
                        denied_m.lock().unwrap().push(path.clone());
                    }
                    measured.lock().unwrap().push((path, r.bytes, true));
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let cancelled = cancel.load(Ordering::Relaxed);

    let mut list = std::mem::take(&mut *measured.lock().unwrap());
    list.retain(|(_, size, _)| *size >= opts.min_size);
    list.sort_by_key(|b| std::cmp::Reverse(b.1));
    list.truncate(opts.limit);

    let paths: Vec<String> = list.iter().map(|(p, _, _)| p.clone()).collect();
    on_progress(Progress { phase: "measuring", current: String::new(), done: done.load(Ordering::Relaxed), total });
    let used = last_used(&paths, &*on_progress);
    on_progress(Progress { phase: "dates", current: String::new(), done: paths.len(), total: paths.len() });
    let items = list
        .into_iter()
        .zip(used)
        .map(|((path, size, dir), last_used_ms)| {
            let modified_ms = fs::symlink_metadata(&path).ok().as_ref().and_then(mtime_ms);
            let name = path.rsplit('/').next().unwrap_or("").to_string();
            ScanItem {
                category: category_of(&path, &roots),
                blocked: cannot_remove(&path, &opts.home, &roots, true),
                name,
                path,
                size,
                dir,
                modified_ms,
                last_used_ms,
            }
        })
        .collect();
    let mut denied = std::mem::take(&mut *denied_m.lock().unwrap());
    denied.sort();
    denied.dedup();
    ScanResult { items, denied, disk: disk_space(), cancelled }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdls_dates() {
        assert_eq!(parse_mdls_date("1970-01-02 00:00:00 +0000"), Some(86_400_000.0));
        assert_eq!(parse_mdls_date("2024-03-01 12:00:00 +0000"), Some(1_709_294_400_000.0));
        assert_eq!(parse_mdls_date("(null)"), None);
    }

    #[test]
    fn scans_a_folder() {
        let dir = std::env::temp_dir().join(format!("fsg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/big.bin"), vec![1u8; 200_000]).unwrap();
        fs::write(dir.join("small.txt"), b"hi").unwrap();
        let seen: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        let seen2 = seen.clone();
        let res = run_scan(
            ScanOptions { home: "/nonexistent-home".into(), folder: Some(dir.to_string_lossy().into()), min_size: 0, limit: 100 },
            Arc::new(AtomicBool::new(false)),
            move |p| seen2.lock().unwrap().push(p.phase),
        );
        let phases = seen.lock().unwrap().clone();
        assert_eq!(phases.first(), Some(&"listing"));
        assert!(phases.contains(&"measuring"));
        assert_eq!(phases.last(), Some(&"dates"));
        assert_eq!(res.items.len(), 2);
        assert_eq!(res.items[0].name, "sub");
        assert!(res.items[0].dir && res.items[0].size >= 200_000);
        assert!(res.items[0].blocked.is_some(), "outside home is blocked");
        let _ = fs::remove_dir_all(&dir);
    }
}
