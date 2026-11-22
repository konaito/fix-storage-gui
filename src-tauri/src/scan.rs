//! Measuring folders. Ported from fix-storage `src/core/scan.ts` and `browse.ts`
//! (MIT, (c) 2026 the fix-storage authors): `du -skx` per folder with a watchdog for
//! macOS privacy prompts, `lstat` for loose files, Spotlight's last-used date via `mdls`.
//! Everything here runs locally; nothing is sent anywhere.

use crate::roots::{category_of, mac_roots, CategoryId, Root};
use crate::safety::cannot_remove;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read};
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
    /// Holds a regular file that is also hard-linked from a path outside this item (#34, #79).
    /// Its blocks stay in use there, so moving this item to the Trash can free less than `size`.
    pub shared: bool,
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
            let frsize = s.f_frsize as u64;
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

/// Reads du's stderr to the end so du never blocks on a full pipe, keeping only whether
/// a permission error was reported (not the text, which can be megabytes).
fn watch_stderr(stderr: impl Read) -> bool {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    let mut denied = false;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return denied,
            Ok(_) => {
                if !denied {
                    let text = String::from_utf8_lossy(&line);
                    denied = text.contains("not permitted") || text.contains("Permission denied");
                }
            }
        }
    }
}

/// `du -skx` for one folder. On macOS a du that used no CPU between two checks
/// 5 s apart is waiting on a privacy prompt: kill it and report the folder unreadable
/// (same rule as fix-storage). A du that cannot be started also counts as unreadable.
fn du(path: &str, cancel: &AtomicBool) -> DuResult {
    let child = Command::new("du").args(["-skx", path]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let Ok(mut child) = child else { return DuResult { bytes: 0, denied: true } };
    // stdout is one short line; stderr gets a line per unreadable folder and must be drained.
    let stderr = child.stderr.take().map(|e| std::thread::spawn(move || watch_stderr(e)));
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
            if let Some(h) = stderr {
                let _ = h.join();
            }
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
    let stdout = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    };
    let stderr_denied = stderr.map(|h| h.join().unwrap_or(false)).unwrap_or(false);
    let kb: u64 = stdout.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
    DuResult { bytes: kb * 1024, denied: stalled || stderr_denied }
}

/// Most entries `has_outside_hard_links` reads in one folder before it stops (#34).
const HARD_LINK_SCAN_CAP: usize = 20_000;

/// A loose file whose blocks are shared with another path (more than one hard link).
fn is_hard_linked(meta: &fs::Metadata) -> bool {
    meta.is_file() && meta.nlink() > 1
}

/// Whether a folder holds a file that is also hard-linked from outside it (#34, #79). du counts
/// such a file in full for every folder that links it, so moving one of them to the Trash can
/// free less than its size. Links that all sit inside the folder (cargo's `target` makes many)
/// are counted once by du and free their size in full, so they do not count here.
/// Walks like `du -x` (no symlinks, stays on the folder's volume) and counts how many links to
/// each hard-linked file it finds; a file found fewer times than its `nlink` has a link outside.
/// At `cap` entries it stops and answers from what it has seen, which leans towards true.
/// On cancel it answers false.
fn has_outside_hard_links(path: &str, cap: usize, cancel: &AtomicBool) -> bool {
    let Ok(top) = fs::symlink_metadata(path) else { return false };
    let dev = top.dev();
    let mut stack = vec![std::path::PathBuf::from(path)];
    let mut seen = 0usize;
    // (dev, ino) -> (links found in this folder, nlink)
    let mut links: HashMap<(u64, u64), (u64, u64)> = HashMap::new();
    let outside = |links: &HashMap<(u64, u64), (u64, u64)>| links.values().any(|(found, nlink)| found < nlink);
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            seen += 1;
            if seen > cap {
                return outside(&links);
            }
            // DirEntry::metadata does not follow symlinks.
            let Ok(meta) = entry.metadata() else { continue };
            if is_hard_linked(&meta) {
                links.entry((meta.dev(), meta.ino())).or_insert((0, meta.nlink())).0 += 1;
            }
            if meta.is_dir() && meta.dev() == dev {
                stack.push(entry.path());
            }
        }
    }
    outside(&links)
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
    /// Path, size, hard-linked.
    File(String, u64, bool),
}

fn holds_root(path: &str, roots: &[Root]) -> bool {
    let prefix = format!("{path}/");
    roots.iter().any(|r| r.path.starts_with(&prefix))
}

/// Collects what to measure. `whole_mac`: every fix-storage root, children measured one by one,
/// nested roots measured on their own so nothing is counted twice. Otherwise: the children of `folder`,
/// and a `folder` that cannot be read for any reason but missing permission is an error.
fn collect_units(
    start: &[String],
    roots: &[Root],
    root_paths: &HashSet<String>,
    nested_aware: bool,
    denied: &mut Vec<String>,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(Progress),
) -> Result<Vec<Unit>, String> {
    let mut units = Vec::new();
    let mut queue: VecDeque<String> = start.iter().cloned().collect();
    while let Some(dir) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        on_progress(Progress { phase: "listing", current: dir.clone(), done: units.len(), total: 0 });
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    denied.push(dir.clone());
                } else if !nested_aware {
                    // Only the chosen folder is ever queued here.
                    return Err(format!("フォルダを読めませんでした: {dir}（{e}）"));
                } else if let Ok(meta) = fs::symlink_metadata(&dir) {
                    // Whole Mac: a root that does not exist on this Mac is normal and skipped.
                    if meta.is_file() {
                        units.push(Unit::File(dir.clone(), meta.blocks() * 512, is_hard_linked(&meta)));
                    }
                }
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    denied.push(dir.clone());
                    continue;
                }
            };
            let child = format!("{}/{}", dir.trim_end_matches('/'), entry.file_name().to_string_lossy());
            if nested_aware && root_paths.contains(&child) {
                continue;
            }
            let meta = match fs::symlink_metadata(&child) {
                Ok(meta) => meta,
                // Removed since the folder was listed.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    denied.push(child);
                    continue;
                }
            };
            if meta.is_dir() {
                if nested_aware && holds_root(&child, roots) {
                    queue.push_back(child);
                } else {
                    units.push(Unit::Dir(child));
                }
            } else {
                units.push(Unit::File(child, meta.blocks() * 512, is_hard_linked(&meta)));
            }
        }
    }
    Ok(units)
}

pub struct ScanOptions {
    pub home: String,
    /// None = every fix-storage root on this Mac; Some(path) = the children of one folder.
    pub folder: Option<String>,
    pub min_size: u64,
    pub limit: usize,
}

pub fn run_scan(opts: ScanOptions, cancel: Arc<AtomicBool>, on_progress: impl Fn(Progress) + Send + Sync + 'static) -> Result<ScanResult, String> {
    let on_progress = Arc::new(on_progress);
    let roots = mac_roots(&opts.home);
    let root_paths: HashSet<String> = roots.iter().map(|r| r.path.clone()).collect();
    let mut denied = Vec::new();
    let units = match &opts.folder {
        None => {
            let start: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
            collect_units(&start, &roots, &root_paths, true, &mut denied, &cancel, &*on_progress)?
        }
        Some(folder) => collect_units(&[folder.clone()], &roots, &root_paths, false, &mut denied, &cancel, &*on_progress)?,
    };

    let total = units.len();
    // (path, size, dir, shared)
    let measured: Arc<Mutex<Vec<(String, u64, bool, bool)>>> = Arc::new(Mutex::new(Vec::with_capacity(total)));
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
                Unit::File(path, bytes, shared) => measured.lock().unwrap().push((path, bytes, false, shared)),
                Unit::Dir(path) => {
                    on_progress(Progress { phase: "measuring", current: path.clone(), done: done.load(Ordering::Relaxed), total });
                    let r = du(&path, &cancel);
                    if r.denied {
                        denied_m.lock().unwrap().push(path.clone());
                    }
                    // Not after a denied or stalled du: the walk could not be killed if it hung on a privacy prompt.
                    let shared = !r.denied && !cancel.load(Ordering::Relaxed) && has_outside_hard_links(&path, HARD_LINK_SCAN_CAP, &cancel);
                    measured.lock().unwrap().push((path, r.bytes, true, shared));
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
    list.retain(|(_, size, _, _)| *size >= opts.min_size);
    list.sort_by(|a, b| b.1.cmp(&a.1));
    list.truncate(opts.limit);

    let paths: Vec<String> = list.iter().map(|(p, _, _, _)| p.clone()).collect();
    on_progress(Progress { phase: "measuring", current: String::new(), done: done.load(Ordering::Relaxed), total });
    // A cancelled scan (stopped by the user or replaced by a new scan) returns at once, without dates.
    let used = if cancelled {
        vec![None; paths.len()]
    } else {
        let used = last_used(&paths, &*on_progress);
        on_progress(Progress { phase: "dates", current: String::new(), done: paths.len(), total: paths.len() });
        used
    };
    let items = list
        .into_iter()
        .zip(used)
        .map(|((path, size, dir, shared), last_used_ms)| {
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
                shared,
            }
        })
        .collect();
    let mut denied = std::mem::take(&mut *denied_m.lock().unwrap());
    denied.sort();
    denied.dedup();
    Ok(ScanResult { items, denied, disk: disk_space(), cancelled })
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
        let dir = std::env::temp_dir().join(format!("fsg-test-scans-{}", std::process::id()));
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
        )
        .unwrap();
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

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fsg-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// #33: with many unreadable subfolders du writes more than a pipe's worth of errors to stderr.
    /// It must not stall on that pipe (the watchdog would then kill it and report size 0).
    #[test]
    fn du_many_denied_subfolders() {
        let dir = temp_dir("du-denied");
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("data.bin"), vec![7u8; 5_000_000]).unwrap();
        let long = "x".repeat(200);
        let mut locked = Vec::new();
        for i in 0..1500 {
            let d = target.join(format!("{long}-{i}"));
            fs::create_dir(&d).unwrap();
            fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
            locked.push(d);
        }
        let started = Instant::now();
        let r = du(&target.to_string_lossy(), &AtomicBool::new(false));
        let took = started.elapsed();
        for d in &locked {
            let _ = fs::set_permissions(d, std::os::unix::fs::PermissionsExt::from_mode(0o755));
        }
        let _ = fs::remove_dir_all(&dir);
        assert!(r.bytes >= 5_000_000, "size was {} after {:?}", r.bytes, took);
        assert!(r.denied, "unreadable subfolders are reported");
    }

    /// #39: a folder that cannot be read is an error, not an empty result.
    #[test]
    fn missing_folder_is_an_error() {
        let res = run_scan(
            ScanOptions { home: "/nonexistent-home".into(), folder: Some("/nonexistent/zzz".into()), min_size: 0, limit: 100 },
            Arc::new(AtomicBool::new(false)),
            |_| {},
        );
        let err = res.err().expect("missing folder looked like an empty folder");
        assert!(err.contains("/nonexistent/zzz"), "{err}");
    }

    /// #40: a scan cancelled before it starts lists nothing and never asks Spotlight for dates.
    #[test]
    fn cancelled_scan_skips_listing_and_dates() {
        let dir = temp_dir("cancelled");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/a.bin"), vec![1u8; 10_000]).unwrap();
        let seen: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        let seen2 = seen.clone();
        let res = run_scan(
            ScanOptions { home: "/nonexistent-home".into(), folder: Some(dir.to_string_lossy().into()), min_size: 0, limit: 100 },
            Arc::new(AtomicBool::new(true)),
            move |p| seen2.lock().unwrap().push(p.phase),
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        let phases = seen.lock().unwrap().clone();
        assert!(res.cancelled);
        assert!(!phases.contains(&"listing"), "listing ran after cancel: {phases:?}");
        assert!(!phases.contains(&"dates"), "dates ran after cancel: {phases:?}");
    }

    /// #34: one file hard-linked into three folders. du counts it in full for each folder,
    /// so every item that holds a link is marked as shared; a folder without links is not.
    #[test]
    fn hardlinks_are_marked_shared() {
        let dir = temp_dir("hardlinks");
        for d in ["store", "proj1", "proj2", "plain"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("store/blob.bin"), vec![3u8; 1_000_000]).unwrap();
        fs::hard_link(dir.join("store/blob.bin"), dir.join("proj1/blob.bin")).unwrap();
        fs::create_dir_all(dir.join("proj2/deep/er")).unwrap();
        fs::hard_link(dir.join("store/blob.bin"), dir.join("proj2/deep/er/blob.bin")).unwrap();
        fs::hard_link(dir.join("store/blob.bin"), dir.join("loose.bin")).unwrap();
        fs::write(dir.join("plain/own.bin"), vec![4u8; 1_000_000]).unwrap();
        fs::write(dir.join("alone.bin"), vec![5u8; 1_000_000]).unwrap();
        let res = run_scan(
            ScanOptions { home: "/nonexistent-home".into(), folder: Some(dir.to_string_lossy().into()), min_size: 0, limit: 100 },
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        let shared = |name: &str| res.items.iter().find(|i| i.name == name).unwrap_or_else(|| panic!("{name} missing")).shared;
        for name in ["store", "proj1", "proj2", "loose.bin"] {
            assert!(shared(name), "{name} holds a hard link but is not marked shared");
        }
        for name in ["plain", "alone.bin"] {
            assert!(!shared(name), "{name} has no hard links but is marked shared");
        }
    }

    /// #79: links that all sit inside one item (like cargo's `target`) free their size in full,
    /// so that item is not marked; an item with a link to a path outside it is.
    #[test]
    fn links_only_inside_an_item_are_not_shared() {
        let dir = temp_dir("hardlinks-inside");
        for d in ["inside/sub", "out1", "out2", "mixed"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("inside/a.bin"), vec![6u8; 1_000_000]).unwrap();
        fs::hard_link(dir.join("inside/a.bin"), dir.join("inside/b.bin")).unwrap();
        fs::hard_link(dir.join("inside/a.bin"), dir.join("inside/sub/c.bin")).unwrap();
        fs::write(dir.join("out1/x.bin"), vec![7u8; 1_000_000]).unwrap();
        fs::hard_link(dir.join("out1/x.bin"), dir.join("out2/x.bin")).unwrap();
        fs::write(dir.join("mixed/p.bin"), vec![8u8; 1_000_000]).unwrap();
        fs::hard_link(dir.join("mixed/p.bin"), dir.join("mixed/q.bin")).unwrap();
        fs::write(dir.join("mixed/r.bin"), vec![9u8; 1_000_000]).unwrap();
        fs::hard_link(dir.join("mixed/r.bin"), dir.join("out2/r.bin")).unwrap();
        let res = run_scan(
            ScanOptions { home: "/nonexistent-home".into(), folder: Some(dir.to_string_lossy().into()), min_size: 0, limit: 100 },
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        let shared = |name: &str| res.items.iter().find(|i| i.name == name).unwrap_or_else(|| panic!("{name} missing")).shared;
        assert!(!shared("inside"), "inside links only to itself but is marked shared");
        for name in ["out1", "out2", "mixed"] {
            assert!(shared(name), "{name} links to a path outside it but is not marked shared");
        }
    }

    /// #34, #79: the walk stops after `cap` entries and answers from what it has seen, so a link
    /// whose twin it has not reached yet counts as outside. On cancel it answers false.
    #[test]
    fn hard_link_walk_is_capped() {
        let dir = temp_dir("hardlink-cap");
        for d in ["item", "inside"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("item/a.bin"), b"a").unwrap();
        fs::hard_link(dir.join("item/a.bin"), dir.join("b.bin")).unwrap();
        fs::write(dir.join("inside/p.bin"), b"p").unwrap();
        fs::hard_link(dir.join("inside/p.bin"), dir.join("inside/q.bin")).unwrap();
        let item = dir.join("item").to_string_lossy().to_string();
        let inside = dir.join("inside").to_string_lossy().to_string();
        let found = has_outside_hard_links(&item, 100, &AtomicBool::new(false));
        let capped = has_outside_hard_links(&item, 0, &AtomicBool::new(false));
        let cancelled = has_outside_hard_links(&item, 100, &AtomicBool::new(true));
        let inside_full = has_outside_hard_links(&inside, 100, &AtomicBool::new(false));
        let inside_half = has_outside_hard_links(&inside, 1, &AtomicBool::new(false));
        let _ = fs::remove_dir_all(&dir);
        assert!(found);
        assert!(!capped);
        assert!(!cancelled);
        assert!(!inside_full);
        assert!(inside_half, "stopped after one of two inside links, so the other may be outside");
    }
}
