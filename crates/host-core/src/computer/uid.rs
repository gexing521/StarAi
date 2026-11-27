//! Element identity encoding shared across platform accessibility backends.
//!
//! `uid` encodes the child-index path from the window root plus a digest of the
//! role and label observed during inspection. A later action re-walks the path
//! and checks the digest, so a tree that mutated underneath refuses instead of
//! acting on whatever now sits at that position.

pub(crate) fn make_uid(path: &[usize], role: &str, label: Option<&str>) -> String {
    let joined = path
        .iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>()
        .join(".");
    format!("{joined}#{:x}", identity_digest(role, label))
}

pub(crate) fn identity_digest(role: &str, label: Option<&str>) -> u32 {
    // FNV-1a over role and label. This is a change detector, not a secret.
    let mut hash: u32 = 0x811c_9dc5;
    for byte in role.as_bytes().iter().chain(label.unwrap_or("").as_bytes()) {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

pub(crate) fn parse_uid(uid: &str) -> Option<(Vec<usize>, u32)> {
    let (path, digest) = uid.split_once('#')?;
    let indices = path
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<usize>().ok())
        .collect::<Option<Vec<_>>>()?;
    let digest = u32::from_str_radix(digest, 16).ok()?;
    Some((indices, digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_round_trips_path_and_identity() {
        let uid = make_uid(&[0, 3, 2], "Button", Some("Save"));
        let (path, digest) = parse_uid(&uid).expect("parse");
        assert_eq!(path, vec![0, 3, 2]);
        assert_eq!(digest, identity_digest("Button", Some("Save")));
    }

    #[test]
    fn uid_rejects_malformed_inputs() {
        for uid in ["", "abc", "1.2", "1.x#ff", "1.2#zz", "-1#ff", "1.2#"] {
            assert!(parse_uid(uid).is_none(), "accepted {uid}");
        }
    }

    #[test]
    fn root_uid_has_empty_path() {
        let uid = make_uid(&[], "Window", Some("Notepad"));
        let (path, _) = parse_uid(&uid).expect("root");
        assert!(path.is_empty());
    }
}
