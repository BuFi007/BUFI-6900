// SPDX-License-Identifier: Apache-2.0
//! Weighted FROST(Ed25519, SHA-512) threshold key for a Circle Gateway delegate on Solana.
//!
//! Gateway on Solana only accepts an Ed25519 signature from the depositor or a registered delegate, and a Squads
//! vault (a PDA) has no key. So the Squads quorum registers ONE delegate whose key is split among the treasury
//! owners: weights become share counts, the threshold becomes the share threshold, and the aggregate is a plain
//! RFC 8032 Ed25519 signature that Gateway verifies like any other. Nobody ever holds the whole key: shares come
//! from a distributed key generation (DKG), not a dealer.
//!
//!   frost-delegate dkg  --dir <dir> --owners A:2,B:1,C:1 --threshold 3
//!   frost-delegate sign --dir <dir> --signers A,B --message-hex <hex>
//!
//! `dkg` writes `<dir>/share-<n>.json` (one per share; owner A of weight 2 gets two files), `<dir>/owners.json`
//! (owner → share ids) and `<dir>/group.json` (the group verifying key as hex). `sign` uses every share of every
//! listed owner, refuses if they hold fewer than `threshold` shares, runs both FROST rounds, aggregates, verifies
//! the result with ed25519-dalek against the group key, and prints `{"signature":"0x…","groupKey":"0x…"}`.
//!
//! The sandbox runs every participant in one process. In production each owner's device holds only its own share
//! file(s) and the rounds go through a coordinator; the math and the output are the same.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use ed25519_dalek::{Signature as DalekSignature, Verifier, VerifyingKey as DalekKey};
use frost_ed25519 as frost;
use rand::thread_rng;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Owners {
    threshold: u16,
    /// owner label → share identifiers (1-based)
    shares: BTreeMap<String, Vec<u16>>,
}

#[derive(Serialize, Deserialize)]
struct Group {
    group_key_hex: String,
    threshold: u16,
    total_shares: u16,
}

fn arg(args: &[String], name: &str) -> String {
    let i = args.iter().position(|a| a == name).unwrap_or_else(|| panic!("missing {name}"));
    args.get(i + 1).cloned().unwrap_or_else(|| panic!("missing value for {name}"))
}

fn id(n: u16) -> frost::Identifier {
    frost::Identifier::try_from(n).expect("non-zero identifier")
}

fn dkg(dir: &Path, owners_spec: &str, threshold: u16) {
    // Weights → share ids: "A:2,B:1,C:1" → A:[1,2], B:[3], C:[4]
    let mut owners = Owners { threshold, shares: BTreeMap::new() };
    let mut next: u16 = 1;
    for part in owners_spec.split(',') {
        let (label, weight) = part.split_once(':').expect("owner as LABEL:WEIGHT");
        let weight: u16 = weight.parse().expect("integer weight");
        assert!(weight >= 1, "weight must be >= 1");
        let ids: Vec<u16> = (next..next + weight).collect();
        next += weight;
        owners.shares.insert(label.to_string(), ids);
    }
    let n = next - 1;
    assert!(threshold >= 2 && threshold <= n, "threshold must be in [2, total shares]");

    let mut rng = thread_rng();
    // Round 1: every participant commits to a random polynomial.
    let mut r1_secret = BTreeMap::new();
    let mut r1_pkgs = BTreeMap::new();
    for i in 1..=n {
        let (secret, pkg) = frost::keys::dkg::part1(id(i), n, threshold, &mut rng).expect("dkg part1");
        r1_secret.insert(id(i), secret);
        r1_pkgs.insert(id(i), pkg);
    }
    // Round 2: every participant sends each other participant its share of its polynomial.
    let mut r2_secret = BTreeMap::new();
    let mut r2_inbox: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package>> =
        BTreeMap::new();
    for i in 1..=n {
        let others: BTreeMap<_, _> = r1_pkgs.iter().filter(|(k, _)| **k != id(i)).map(|(k, v)| (*k, v.clone())).collect();
        let (secret, outgoing) = frost::keys::dkg::part2(r1_secret.remove(&id(i)).unwrap(), &others).expect("dkg part2");
        r2_secret.insert(id(i), secret);
        for (to, pkg) in outgoing {
            r2_inbox.entry(to).or_default().insert(id(i), pkg);
        }
    }
    // Round 3: every participant derives its signing share and the shared group key.
    fs::create_dir_all(dir).expect("create dir");
    let mut group_key: Option<frost::keys::PublicKeyPackage> = None;
    for i in 1..=n {
        let others: BTreeMap<_, _> = r1_pkgs.iter().filter(|(k, _)| **k != id(i)).map(|(k, v)| (*k, v.clone())).collect();
        let (key_pkg, pub_pkg) =
            frost::keys::dkg::part3(&r2_secret[&id(i)], &others, &r2_inbox[&id(i)]).expect("dkg part3");
        if let Some(prev) = &group_key {
            assert_eq!(prev.verifying_key(), pub_pkg.verifying_key(), "participants disagree on the group key");
        }
        group_key = Some(pub_pkg);
        fs::write(dir.join(format!("share-{i}.json")), serde_json::to_vec_pretty(&key_pkg).unwrap()).expect("write share");
    }
    let pub_pkg = group_key.unwrap();
    fs::write(dir.join("public.json"), serde_json::to_vec_pretty(&pub_pkg).unwrap()).expect("write public");
    let group_hex = hex::encode(pub_pkg.verifying_key().serialize().expect("serialize key"));
    fs::write(
        dir.join("group.json"),
        serde_json::to_vec_pretty(&Group { group_key_hex: format!("0x{group_hex}"), threshold, total_shares: n }).unwrap(),
    )
    .expect("write group");
    fs::write(dir.join("owners.json"), serde_json::to_vec_pretty(&owners).unwrap()).expect("write owners");
    println!("{}", serde_json::json!({ "groupKey": format!("0x{group_hex}"), "threshold": threshold, "totalShares": n, "owners": owners.shares }));
}

fn sign(dir: &Path, signers: &str, message: &[u8]) {
    let owners: Owners = serde_json::from_slice(&fs::read(dir.join("owners.json")).expect("owners.json")).unwrap();
    let pub_pkg: frost::keys::PublicKeyPackage =
        serde_json::from_slice(&fs::read(dir.join("public.json")).expect("public.json")).unwrap();

    let mut share_ids: Vec<u16> = Vec::new();
    for label in signers.split(',') {
        let ids = owners.shares.get(label).unwrap_or_else(|| panic!("unknown owner {label}"));
        share_ids.extend(ids);
    }
    if share_ids.len() < owners.threshold as usize {
        eprintln!(
            "{}",
            serde_json::json!({ "error": "below threshold", "shares": share_ids.len(), "threshold": owners.threshold })
        );
        std::process::exit(2);
    }

    let mut rng = thread_rng();
    let mut keys = BTreeMap::new();
    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();
    // Round 1: each share holder commits to fresh nonces.
    for i in &share_ids {
        let key: frost::keys::KeyPackage =
            serde_json::from_slice(&fs::read(dir.join(format!("share-{i}.json"))).expect("share file")).unwrap();
        let (n, c) = frost::round1::commit(key.signing_share(), &mut rng);
        nonces.insert(id(*i), n);
        commitments.insert(id(*i), c);
        keys.insert(id(*i), key);
    }
    // Round 2: each share holder signs the same signing package.
    let package = frost::SigningPackage::new(commitments, message);
    let mut shares = BTreeMap::new();
    for (ident, key) in &keys {
        let s = frost::round2::sign(&package, &nonces[ident], key).expect("round2 sign");
        shares.insert(*ident, s);
    }
    // Aggregate into one Ed25519 signature and check it the way Gateway will: plain RFC 8032 verification.
    let sig = frost::aggregate(&package, &shares, &pub_pkg).expect("aggregate");
    let sig_bytes = sig.serialize().expect("serialize signature");
    let key_bytes = pub_pkg.verifying_key().serialize().expect("serialize key");
    let dalek_key = DalekKey::from_bytes(&key_bytes.clone().try_into().unwrap()).expect("valid ed25519 key");
    let dalek_sig = DalekSignature::from_slice(&sig_bytes).expect("64-byte signature");
    dalek_key.verify(message, &dalek_sig).expect("aggregate must verify as plain Ed25519");

    println!(
        "{}",
        serde_json::json!({
            "signature": format!("0x{}", hex::encode(&sig_bytes)),
            "groupKey": format!("0x{}", hex::encode(&key_bytes)),
            "shares": share_ids,
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("dkg") => dkg(Path::new(&arg(&args, "--dir")), &arg(&args, "--owners"), arg(&args, "--threshold").parse().unwrap()),
        Some("sign") => {
            let msg = hex::decode(arg(&args, "--message-hex").trim_start_matches("0x")).expect("hex message");
            sign(Path::new(&arg(&args, "--dir")), &arg(&args, "--signers"), &msg)
        }
        _ => {
            eprintln!("usage: frost-delegate dkg --dir D --owners A:2,B:1,C:1 --threshold 3 | sign --dir D --signers A,B --message-hex 0x…");
            std::process::exit(64)
        }
    }
}
