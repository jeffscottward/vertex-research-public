//! Build identity is supplied by a reviewed release, never invented at runtime.
//! Source hash algorithm: SHA256(domain || ordered(path || NUL || file_sha256)).
//! Paths are UTF-8, services-relative, sorted bytewise; file_sha256 is raw 32 bytes.
use sha2::{Digest, Sha256};
use std::{env, fs, path::{Path, PathBuf}};

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn reviewed(name: &str) -> String {
    println!("cargo:rerun-if-env-changed={name}");
    env::var(name).unwrap_or_else(|_| panic!("required reviewed build identity missing: {name}"))
}

fn sources(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(directory).expect("source directory unavailable") {
        let entry = entry.expect("source entry unavailable");
        let kind = entry.file_type().expect("source type unavailable");
        assert!(!kind.is_symlink(), "source symlinks are not release inputs");
        if kind.is_dir() {
            sources(root, &entry.path(), files);
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "rs") {
            files.push(entry.path().strip_prefix(root).expect("source root mismatch").to_owned());
        }
    }
}

fn main() {
    let build_id = reviewed("VERTEX_KERNEL_BUILD_ID");
    assert!(!build_id.is_empty() && build_id.len() <= 128 && build_id.bytes().all(|b|
        b.is_ascii_alphanumeric() || b"._-".contains(&b)), "invalid reviewed build identifier");
    let expected = reviewed("VERTEX_KERNEL_SOURCE_SHA256");
    let contract = reviewed("VERTEX_KERNEL_CONTRACT_SOURCE_SHA256");
    assert!(digest(&expected) && digest(&contract), "reviewed lowercase SHA256 identities required");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory unavailable"));
    let services = manifest.parent().expect("services root unavailable");
    let mut files = Vec::new();
    // Includes the exact kernel and native authority implementation, not only the
    // public schema-source digest. Bridge image bytes are independently pinned.
    for name in ["execution-kernel", "contracts/rust"] {
        files.push(PathBuf::from(name).join("Cargo.toml"));
        sources(services, &services.join(name).join("src"), &mut files);
    }
    files.sort();
    let mut hash = Sha256::new();
    hash.update(b"vertex-kernel-source-v1\0");
    for relative in files {
        let path = services.join(&relative);
        println!("cargo:rerun-if-changed={}", path.display());
        assert!(fs::symlink_metadata(&path).expect("source metadata unavailable").file_type().is_file(),
            "source must be a regular file");
        let name = relative.to_str().expect("source path must be UTF-8").replace('\\', "/");
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(Sha256::digest(fs::read(path).expect("source bytes unavailable")));
    }
    let actual = format!("{:x}", hash.finalize());
    assert_eq!(expected, actual, "kernel/authority sources differ from reviewed release");
    println!("cargo:rustc-env=VERTEX_KERNEL_BUILD_ID={build_id}");
    println!("cargo:rustc-env=VERTEX_KERNEL_SOURCE_SHA256={actual}");
    println!("cargo:rustc-env=VERTEX_KERNEL_CONTRACT_SOURCE_SHA256={contract}");
}
