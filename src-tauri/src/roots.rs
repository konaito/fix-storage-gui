//! Folders the scan measures and the category each counts toward.
//! Ported from fix-storage `src/core/categories.ts` `roots()` (MIT, (c) 2026 the fix-storage authors).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryId {
    Apps,
    Developer,
    Photos,
    Movies,
    Documents,
    Music,
    System,
    Caches,
    Trash,
}

#[derive(Debug, Clone)]
pub struct Root {
    pub path: String,
    pub category: CategoryId,
    /// Category for dot-folders directly inside this root, when it differs.
    pub hidden: Option<CategoryId>,
}

fn r(path: String, category: CategoryId) -> Root {
    Root { path, category, hidden: None }
}

/// macOS roots, same order and content as fix-storage's `roots(home)`.
pub fn mac_roots(home: &str) -> Vec<Root> {
    use CategoryId::*;
    let h = |p: &str| format!("{}/{}", home.trim_end_matches('/'), p);
    vec![
        r("/Applications".into(), Apps),
        r(h("Applications"), Apps),
        r(h("Library"), Apps),
        r(h("Library/Application Support"), Apps),
        r(h("Library/Containers"), Apps),
        r(h("Library/Group Containers"), Apps),
        r("/Library/Application Support".into(), Apps),
        r(h("Library/Developer"), Developer),
        r(h("Library/Containers/com.docker.docker"), Developer),
        r(h(".docker"), Developer),
        r(h(".cargo"), Developer),
        r(h(".rustup"), Developer),
        r(h("go"), Developer),
        r(h(".gradle"), Developer),
        r(h(".m2"), Developer),
        r(h(".nvm"), Developer),
        r(h(".pyenv"), Developer),
        r(h(".android"), Developer),
        r(h(".bun"), Developer),
        r("/opt/homebrew".into(), Developer),
        r("/usr/local".into(), Developer),
        r("/Library/Developer".into(), Developer),
        r(h("Pictures"), Photos),
        r(h("Movies"), Movies),
        r(h("Documents"), Documents),
        r(h("Desktop"), Documents),
        r(h("Downloads"), Documents),
        r(h("Library/Mobile Documents"), Documents),
        r(h("Library/CloudStorage"), Documents),
        r("/Users/Shared".into(), Documents),
        Root { path: home.trim_end_matches('/').to_string(), category: Documents, hidden: Some(Developer) },
        r(h("Music"), Music),
        r(h("Library/Caches"), Caches),
        r(h(".cache"), Caches),
        r(h(".npm"), Caches),
        r(h("Library/Developer/Xcode/DerivedData"), Caches),
        r(h("Library/Developer/CoreSimulator/Caches"), Caches),
        r(h(".bun/install/cache"), Caches),
        r(h(".gradle/caches"), Caches),
        r(h(".Trash"), Trash),
    ]
}

fn is_within(path: &str, root: &str) -> bool {
    path == root || (path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/'))
}

/// Category of an arbitrary path: the deepest root that contains it decides.
/// Dot-folders directly inside a root with a `hidden` category take that category
/// (and so does everything beneath them). Paths outside every root are "system".
pub fn category_of(path: &str, roots: &[Root]) -> CategoryId {
    let mut best: Option<&Root> = None;
    for root in roots {
        if is_within(path, &root.path) && best.map_or(true, |b| root.path.len() > b.path.len()) {
            best = Some(root);
        }
    }
    match best {
        None => CategoryId::System,
        Some(root) => {
            if let Some(hidden) = root.hidden {
                let rest = path[root.path.len()..].trim_start_matches('/');
                if rest.starts_with('.') {
                    return hidden;
                }
            }
            root.category
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepest_root_wins() {
        let roots = mac_roots("/Users/a");
        assert_eq!(category_of("/Users/a/Library/Caches/x", &roots), CategoryId::Caches);
        assert_eq!(category_of("/Users/a/Library/Developer/Xcode/DerivedData/p", &roots), CategoryId::Caches);
        assert_eq!(category_of("/Users/a/Library/Developer/Xcode", &roots), CategoryId::Developer);
        assert_eq!(category_of("/Users/a/project", &roots), CategoryId::Documents);
        assert_eq!(category_of("/Users/a/.vscode/ext", &roots), CategoryId::Developer);
        assert_eq!(category_of("/Users/a/.Trash/old", &roots), CategoryId::Trash);
        assert_eq!(category_of("/System/Library", &roots), CategoryId::System);
        assert_eq!(category_of("/Users/ab", &roots), CategoryId::System);
    }
}
