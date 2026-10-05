// SPDX-License-Identifier: Apache-2.0
//! Weighted FROST(Ed25519, SHA-512) threshold key for a Circle Gateway delegate on Solana.
//!
//! Gateway on Solana only accepts an Ed25519 signature from the depositor or a registered delegate, and a Squads
//! vault (a PDA) has no key. So the Squads quorum registers ONE delegate whose key is split among the treasury
//! owners: weights become share counts, the threshold becomes the share threshold, and the aggregate is a plain
//! RFC 8032 Ed25519 signature that Gateway verifies like any other.
//!
//!   frost-delegate dkg  --dir <dir> --owners A:2,B:1,C:1 --threshold 3 [--force]
//!   frost-delegate sign --dir <dir> --signers A,B --current-slot <slot> --message-hex <hex>
//!
//! `dkg` writes `<dir>/share-<n>.json` (one per share; owner A of weight 2 gets two files), `<dir>/owners.json`
//! (owner → share ids), `<dir>/public.json` and `<dir>/group.json` (the group verifying key as hex), all mode 0600.
//! It REFUSES to run when any of them exists (a second DKG would replace the key the vault registered as its Gateway
//! delegate, leaving it unsignable); `--force` overrides that deliberately.
//!
//! `sign` is also the policy coordinator. It signs ONLY a message that is exactly one Circle Solana burn intent
//! (16-byte 0xff00… signing-domain prefix + Circle's binary layout, no hook data) and that satisfies
//! `<dir>/policy.json`: depositor = the vault, signer = this group key, this source domain / GatewayWallet / token,
//! destination domain + its GatewayMinter + its token, a recipient (and any destination caller) allowlisted FOR THAT
//! domain, value <= cap, maxFee <= fee cap, maxBlockHeight within `maxExpirySlots` above `--current-slot`. Anything
//! else exits 3 with `{"error":"policy",…}`, and no share is touched. Without policy.json it refuses to sign. Gateway
//! on Solana has no ERC-1271 hook, so this check is OFF-CHAIN ONLY: anyone holding a threshold of share FILES can
//! sign without this binary. It stops blind signing and bugs, not a colluding share majority.
//! Then it uses every share of every listed owner (duplicate or unknown labels are refused), refuses (exit 2) below
//! `threshold` shares, runs both FROST rounds, aggregates, verifies the result with ed25519-dalek against the group
//! key, and prints `{"signature":"0x…","groupKey":"0x…"}`.
//!
//! SANDBOX CAVEAT: this CLI runs every participant in one process, so for the duration of `dkg` (and of each `sign`)
//! that process holds every participant's secrets; it is effectively a trusted dealer. In production each owner's
//! device holds only its own share file(s) and the rounds go through a coordinator; the math and the output are the
//! same, and only then does no single machine ever hold the whole key.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use ed25519_dalek::{Signature as DalekSignature, Verifier, VerifyingKey as DalekKey};
use frost_ed25519 as frost;
use rand::thread_rng;
use serde::{Deserialize, Serialize};

const TRANSFER_SPEC_MAGIC: u32 = 0xca85_def7;
const BURN_INTENT_MAGIC: u32 = 0x070a_fbc2;
const SIGNING_DOMAIN: [u8; 16] = [0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/// Gateway's only non-EVM domain: its words are 32-byte keys; every other domain uses left-padded 20-byte addresses.
const SOLANA_DOMAIN: u32 = 5;
/// Files `dkg` writes; it refuses to overwrite any of them without `--force`.
const DKG_FILES: [&str; 3] = ["group.json", "public.json", "owners.json"];

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

/// `<dir>/policy.json`. 32-byte words are 0x-hex; amounts are decimal strings in token base units.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    depositor: String,
    source_domain: u32,
    source_contract: String,
    source_token: String,
    per_intent_cap: String,
    max_fee_cap: String,
    max_expiry_slots: u64,
    destinations: Vec<Destination>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    domain: u32,
    minter: String,
    token: String,
    recipients: Vec<String>,
    #[serde(default)]
    callers: Vec<String>,
}

/// One decoded Circle Solana burn intent.
struct Intent {
    max_block_height: [u8; 32],
    max_fee: [u8; 32],
    version: u32,
    source_domain: u32,
    destination_domain: u32,
    source_contract: [u8; 32],
    destination_contract: [u8; 32],
    source_token: [u8; 32],
    destination_token: [u8; 32],
    source_depositor: [u8; 32],
    destination_recipient: [u8; 32],
    source_signer: [u8; 32],
    destination_caller: [u8; 32],
    value: [u8; 32],
}

fn arg(args: &[String], name: &str) -> String {
    let i = args.iter().position(|a| a == name).unwrap_or_else(|| usage(&format!("missing {name}")));
    args.get(i + 1).cloned().unwrap_or_else(|| usage(&format!("missing value for {name}")))
}

fn usage(why: &str) -> ! {
    eprintln!("{}", serde_json::json!({ "error": "usage", "reason": why }));
    eprintln!("usage: frost-delegate dkg --dir D --owners A:2,B:1,C:1 --threshold 3 [--force] | sign --dir D --signers A,B --current-slot N --message-hex 0x…");
    std::process::exit(64)
}

fn id(n: u16) -> frost::Identifier {
    frost::Identifier::try_from(n).expect("non-zero identifier")
}

fn hex32(w: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(w))
}

fn parse_hex32(s: &str) -> Result<[u8; 32], String> {
    let b = hex::decode(s.trim_start_matches("0x")).map_err(|e| format!("bad hex {s}: {e}"))?;
    b.try_into().map_err(|_| format!("not 32 bytes: {s}"))
}

/// A 32-byte big-endian word as u128, or None when it does not fit.
fn word_u128(w: &[u8; 32]) -> Option<u128> {
    if w[..16].iter().any(|b| *b != 0) {
        return None;
    }
    Some(u128::from_be_bytes(w[16..].try_into().unwrap()))
}

fn is_canonical_evm(w: &[u8; 32]) -> bool {
    w[..12].iter().all(|b| *b == 0) && w.iter().any(|b| *b != 0)
}

/// The word has the address shape of `domain`: a non-zero left-padded EVM address, or a Solana key with its upper
/// 12 bytes not all zero (the mirror of GatewayIntentPolicy.matchesDomainShape).
fn matches_domain_shape(domain: u32, w: &[u8; 32]) -> bool {
    if domain == SOLANA_DOMAIN {
        !w[..12].iter().all(|b| *b == 0)
    } else {
        is_canonical_evm(w)
    }
}

/// Decodes EXACTLY one prefixed burn intent; anything else (a different message kind, trailing bytes, hook data)
/// is refused so the coordinator never signs bytes it cannot read.
fn parse_message(msg: &[u8]) -> Result<Intent, String> {
    const SPEC_LEN: usize = 340;
    const TOTAL: usize = 16 + 4 + 32 + 32 + 4 + SPEC_LEN;
    if msg.len() != TOTAL {
        return Err(format!("message is {} bytes; one hook-free burn intent is {TOTAL}", msg.len()));
    }
    if msg[..16] != SIGNING_DOMAIN {
        return Err("missing the burn-intent signing-domain prefix".into());
    }
    let mut o = 16;
    let u32_at = |o: usize| u32::from_be_bytes(msg[o..o + 4].try_into().unwrap());
    let w_at = |o: usize| -> [u8; 32] { msg[o..o + 32].try_into().unwrap() };
    if u32_at(o) != BURN_INTENT_MAGIC {
        return Err("not a burn intent (magic)".into());
    }
    o += 4;
    let max_block_height = w_at(o);
    o += 32;
    let max_fee = w_at(o);
    o += 32;
    if u32_at(o) as usize != SPEC_LEN {
        return Err("transfer spec length".into());
    }
    o += 4;
    if u32_at(o) != TRANSFER_SPEC_MAGIC {
        return Err("not a transfer spec (magic)".into());
    }
    let version = u32_at(o + 4);
    let source_domain = u32_at(o + 8);
    let destination_domain = u32_at(o + 12);
    o += 16;
    // 8 address words, value, salt
    let mut words = [[0u8; 32]; 10];
    for w in &mut words {
        *w = w_at(o);
        o += 32;
    }
    if u32_at(o) != 0 {
        return Err("hook data must be empty".into());
    }
    Ok(Intent {
        max_block_height,
        max_fee,
        version,
        source_domain,
        destination_domain,
        source_contract: words[0],
        destination_contract: words[1],
        source_token: words[2],
        destination_token: words[3],
        source_depositor: words[4],
        destination_recipient: words[5],
        source_signer: words[6],
        destination_caller: words[7],
        value: words[8],
    })
}

/// The same rules GatewayIntentPolicy enforces on EVM, checked before any share signs.
fn check_policy(i: &Intent, p: &Policy, group_key: &[u8; 32], current_slot: u64) -> Result<(), String> {
    let eq = |got: &[u8; 32], want: &str, what: &str| -> Result<(), String> {
        if *got == parse_hex32(want)? {
            Ok(())
        } else {
            Err(format!("{what} {} is not {want}", hex32(got)))
        }
    };
    if i.version != 1 {
        return Err("transfer spec version".into());
    }
    if i.source_domain != p.source_domain {
        return Err(format!("source domain {} is not {}", i.source_domain, p.source_domain));
    }
    eq(&i.source_contract, &p.source_contract, "source contract")?;
    eq(&i.source_token, &p.source_token, "source token")?;
    eq(&i.source_depositor, &p.depositor, "depositor")?;
    if i.source_signer != *group_key {
        return Err("source signer is not this delegate key".into());
    }

    let cap: u128 = p.per_intent_cap.parse().map_err(|_| "policy perIntentCap".to_string())?;
    let fee_cap: u128 = p.max_fee_cap.parse().map_err(|_| "policy maxFeeCap".to_string())?;
    let value = word_u128(&i.value).ok_or("value too large")?;
    if value == 0 || value > cap {
        return Err(format!("value {value} outside (0, {cap}]"));
    }
    let fee = word_u128(&i.max_fee).ok_or("maxFee too large")?;
    if fee > fee_cap {
        return Err(format!("maxFee {fee} above {fee_cap}"));
    }
    let mbh = word_u128(&i.max_block_height).ok_or("maxBlockHeight too large")?;
    let now = current_slot as u128;
    if mbh <= now || mbh - now > p.max_expiry_slots as u128 {
        return Err(format!("maxBlockHeight {mbh} not within {} slots above {now}", p.max_expiry_slots));
    }

    let d = p
        .destinations
        .iter()
        .find(|d| d.domain == i.destination_domain)
        .ok_or_else(|| format!("destination domain {} not allowed", i.destination_domain))?;
    eq(&i.destination_contract, &d.minter, "destination contract")?;
    eq(&i.destination_token, &d.token, "destination token")?;
    let in_set = |w: &[u8; 32], set: &[String]| -> Result<bool, String> {
        for s in set {
            if parse_hex32(s)? == *w {
                return Ok(true);
            }
        }
        Ok(false)
    };
    if !matches_domain_shape(d.domain, &i.destination_recipient) || !in_set(&i.destination_recipient, &d.recipients)? {
        return Err(format!("recipient {} not allowed on domain {}", hex32(&i.destination_recipient), d.domain));
    }
    if i.destination_caller != [0u8; 32]
        && (!matches_domain_shape(d.domain, &i.destination_caller) || !in_set(&i.destination_caller, &d.callers)?)
    {
        return Err(format!("destination caller {} not allowed", hex32(&i.destination_caller)));
    }
    Ok(())
}

/// Share ids for a comma-separated owner list. Unknown or repeated labels are refused, never counted twice.
fn resolve_shares(owners: &Owners, signers: &str) -> Result<Vec<u16>, String> {
    let mut seen = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for label in signers.split(',') {
        if !seen.insert(label) {
            return Err(format!("duplicate signer {label}"));
        }
        let shares = owners.shares.get(label).ok_or_else(|| format!("unknown owner {label}"))?;
        ids.extend(shares.iter().copied());
    }
    Ok(ids.into_iter().collect())
}

/// Writes secret material owner-only (0600). Without `force`, an existing file is an error, never overwritten.
fn write_secret(path: &Path, bytes: &[u8], force: bool) -> Result<(), String> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).mode(0o600);
    if force {
        opts.create(true).truncate(true);
    } else {
        opts.create_new(true);
    }
    let mut f = opts.open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    // `mode` applies only on creation: enforce 0600 on an overwritten file too.
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|e| e.to_string())
}

fn run_dkg(dir: &Path, owners_spec: &str, threshold: u16, force: bool) -> Result<serde_json::Value, String> {
    // Weights → share ids: "A:2,B:1,C:1" → A:[1,2], B:[3], C:[4]
    let mut owners = Owners { threshold, shares: BTreeMap::new() };
    let mut next: u16 = 1;
    for part in owners_spec.split(',') {
        let (label, weight) = part.split_once(':').ok_or("owner as LABEL:WEIGHT")?;
        let weight: u16 = weight.parse().map_err(|_| "integer weight")?;
        if weight < 1 {
            return Err("weight must be >= 1".into());
        }
        if owners.shares.contains_key(label) {
            return Err(format!("duplicate owner {label}"));
        }
        owners.shares.insert(label.to_string(), (next..next + weight).collect());
        next += weight;
    }
    let n = next - 1;
    if threshold < 2 || threshold > n {
        return Err("threshold must be in [2, total shares]".into());
    }

    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if !force {
        let existing = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|f| DKG_FILES.contains(&f.as_str()) || (f.starts_with("share-") && f.ends_with(".json")));
        if let Some(f) = existing {
            return Err(format!(
                "{} already holds key material ({f}); a new DKG would replace the registered delegate key. Pass --force to do it anyway",
                dir.display()
            ));
        }
    }

    let mut rng = thread_rng();
    // Round 1: every participant commits to a random polynomial.
    let mut r1_secret = BTreeMap::new();
    let mut r1_pkgs = BTreeMap::new();
    for i in 1..=n {
        let (secret, pkg) = frost::keys::dkg::part1(id(i), n, threshold, &mut rng).map_err(|e| e.to_string())?;
        r1_secret.insert(id(i), secret);
        r1_pkgs.insert(id(i), pkg);
    }
    // Round 2: every participant sends each other participant its share of its polynomial.
    let mut r2_secret = BTreeMap::new();
    let mut r2_inbox: BTreeMap<frost::Identifier, BTreeMap<frost::Identifier, frost::keys::dkg::round2::Package>> =
        BTreeMap::new();
    for i in 1..=n {
        let others: BTreeMap<_, _> = r1_pkgs.iter().filter(|(k, _)| **k != id(i)).map(|(k, v)| (*k, v.clone())).collect();
        let (secret, outgoing) =
            frost::keys::dkg::part2(r1_secret.remove(&id(i)).unwrap(), &others).map_err(|e| e.to_string())?;
        r2_secret.insert(id(i), secret);
        for (to, pkg) in outgoing {
            r2_inbox.entry(to).or_default().insert(id(i), pkg);
        }
    }
    // Round 3: every participant derives its signing share and the shared group key.
    let mut group_key: Option<frost::keys::PublicKeyPackage> = None;
    let mut key_pkgs = Vec::new();
    for i in 1..=n {
        let others: BTreeMap<_, _> = r1_pkgs.iter().filter(|(k, _)| **k != id(i)).map(|(k, v)| (*k, v.clone())).collect();
        let (key_pkg, pub_pkg) =
            frost::keys::dkg::part3(&r2_secret[&id(i)], &others, &r2_inbox[&id(i)]).map_err(|e| e.to_string())?;
        if let Some(prev) = &group_key {
            if prev.verifying_key() != pub_pkg.verifying_key() {
                return Err("participants disagree on the group key".into());
            }
        }
        group_key = Some(pub_pkg);
        key_pkgs.push((i, key_pkg));
    }
    let pub_pkg = group_key.unwrap();
    let group_hex = hex::encode(pub_pkg.verifying_key().serialize().map_err(|e| e.to_string())?);
    for (i, key_pkg) in &key_pkgs {
        write_secret(&dir.join(format!("share-{i}.json")), &serde_json::to_vec_pretty(key_pkg).unwrap(), force)?;
    }
    write_secret(&dir.join("public.json"), &serde_json::to_vec_pretty(&pub_pkg).unwrap(), force)?;
    let group = Group { group_key_hex: format!("0x{group_hex}"), threshold, total_shares: n };
    write_secret(&dir.join("group.json"), &serde_json::to_vec_pretty(&group).unwrap(), force)?;
    write_secret(&dir.join("owners.json"), &serde_json::to_vec_pretty(&owners).unwrap(), force)?;
    Ok(serde_json::json!({ "groupKey": format!("0x{group_hex}"), "threshold": threshold, "totalShares": n, "owners": owners.shares }))
}

fn fail(code: i32, error: &str, reason: &str) -> ! {
    eprintln!("{}", serde_json::json!({ "error": error, "reason": reason }));
    std::process::exit(code)
}

fn sign(dir: &Path, signers: &str, message: &[u8], current_slot: u64) {
    let owners: Owners = serde_json::from_slice(&fs::read(dir.join("owners.json")).expect("owners.json")).unwrap();
    let pub_pkg: frost::keys::PublicKeyPackage =
        serde_json::from_slice(&fs::read(dir.join("public.json")).expect("public.json")).unwrap();
    let key_bytes = pub_pkg.verifying_key().serialize().expect("serialize key");
    let group_key: [u8; 32] = key_bytes.clone().try_into().expect("32-byte group key");

    // Policy first: nothing is signed that the coordinator cannot read and approve.
    let policy: Policy = match fs::read(dir.join("policy.json")) {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| fail(3, "policy", &format!("policy.json: {e}"))),
        Err(_) => fail(3, "policy", "no policy.json: refusing to sign"),
    };
    let intent = parse_message(message).unwrap_or_else(|e| fail(3, "policy", &e));
    if let Err(e) = check_policy(&intent, &policy, &group_key, current_slot) {
        fail(3, "policy", &e)
    }

    let share_ids = resolve_shares(&owners, signers).unwrap_or_else(|e| fail(64, "signers", &e));
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
    let dalek_key = DalekKey::from_bytes(&group_key).expect("valid ed25519 key");
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
        Some("dkg") => {
            let threshold = arg(&args, "--threshold").parse().unwrap_or_else(|_| usage("--threshold must be an integer"));
            let force = args.iter().any(|a| a == "--force");
            match run_dkg(Path::new(&arg(&args, "--dir")), &arg(&args, "--owners"), threshold, force) {
                Ok(out) => println!("{out}"),
                Err(e) => fail(1, "dkg", &e),
            }
        }
        Some("sign") => {
            let msg = hex::decode(arg(&args, "--message-hex").trim_start_matches("0x")).unwrap_or_else(|_| usage("--message-hex"));
            let slot = arg(&args, "--current-slot").parse().unwrap_or_else(|_| usage("--current-slot must be an integer"));
            sign(Path::new(&arg(&args, "--dir")), &arg(&args, "--signers"), &msg, slot)
        }
        _ => usage("unknown command"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn evm(b: u8) -> [u8; 32] {
        let mut w = [0u8; 32];
        for x in &mut w[12..] {
            *x = b;
        }
        w
    }
    fn u256(v: u128) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[16..].copy_from_slice(&v.to_be_bytes());
        w
    }

    struct Fields {
        max_block_height: u128,
        max_fee: u128,
        source_domain: u32,
        destination_domain: u32,
        destination_contract: [u8; 32],
        destination_token: [u8; 32],
        depositor: [u8; 32],
        recipient: [u8; 32],
        signer: [u8; 32],
        caller: [u8; 32],
        value: u128,
        hook: Vec<u8>,
    }

    fn ok_fields() -> Fields {
        Fields {
            max_block_height: 1_000 + 3_000_000,
            max_fee: 2_010_000,
            source_domain: 5,
            destination_domain: 26,
            destination_contract: evm(0x22),
            destination_token: evm(0x36),
            depositor: word(0xd0),
            recipient: evm(0xf7),
            signer: word(0x9e),
            caller: [0u8; 32],
            value: 1_000_000,
            hook: vec![],
        }
    }

    fn encode(f: &Fields) -> Vec<u8> {
        let mut spec = Vec::new();
        spec.extend(TRANSFER_SPEC_MAGIC.to_be_bytes());
        spec.extend(1u32.to_be_bytes());
        spec.extend(f.source_domain.to_be_bytes());
        spec.extend(f.destination_domain.to_be_bytes());
        spec.extend(word(0x77)); // source contract (GatewayWallet)
        spec.extend(f.destination_contract);
        spec.extend(word(0x55)); // source token
        spec.extend(f.destination_token);
        spec.extend(f.depositor);
        spec.extend(f.recipient);
        spec.extend(f.signer);
        spec.extend(f.caller);
        spec.extend(u256(f.value));
        spec.extend(word(0x5a)); // salt
        spec.extend((f.hook.len() as u32).to_be_bytes());
        spec.extend(&f.hook);
        let mut m = SIGNING_DOMAIN.to_vec();
        m.extend(BURN_INTENT_MAGIC.to_be_bytes());
        m.extend(u256(f.max_block_height));
        m.extend(u256(f.max_fee));
        m.extend((spec.len() as u32).to_be_bytes());
        m.extend(spec);
        m
    }

    fn policy() -> Policy {
        Policy {
            depositor: hex32(&word(0xd0)),
            source_domain: 5,
            source_contract: hex32(&word(0x77)),
            source_token: hex32(&word(0x55)),
            per_intent_cap: "2000000".into(),
            max_fee_cap: "2010000".into(),
            max_expiry_slots: 3_034_000,
            destinations: vec![Destination {
                domain: 26,
                minter: hex32(&evm(0x22)),
                token: hex32(&evm(0x36)),
                recipients: vec![hex32(&evm(0xf7))],
                callers: vec![],
            }],
        }
    }

    fn check(f: &Fields) -> Result<(), String> {
        let intent = parse_message(&encode(f))?;
        check_policy(&intent, &policy(), &word(0x9e), 1_000)
    }

    #[test]
    fn policy_accepts_the_canonical_intent() {
        check(&ok_fields()).unwrap();
    }

    #[test]
    fn policy_refuses_each_violation() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Fields)>)> = vec![
            ("recipient", Box::new(|f| f.recipient = evm(0xba))),
            ("solana-shaped recipient on EVM domain", Box::new(|f| f.recipient = word(0xf7))),
            ("domain", Box::new(|f| f.destination_domain = 6)),
            ("minter", Box::new(|f| f.destination_contract = evm(0xde))),
            ("token", Box::new(|f| f.destination_token = evm(0xde))),
            ("depositor", Box::new(|f| f.depositor = word(0x01))),
            ("signer", Box::new(|f| f.signer = word(0x01))),
            ("source domain", Box::new(|f| f.source_domain = 26)),
            ("caller", Box::new(|f| f.caller = evm(0xca))),
            ("value over cap", Box::new(|f| f.value = 2_000_001)),
            ("value zero", Box::new(|f| f.value = 0)),
            ("fee", Box::new(|f| f.max_fee = 2_010_001)),
            ("expiry", Box::new(|f| f.max_block_height = 1_000 + 3_034_001)),
            ("already expired", Box::new(|f| f.max_block_height = 999)),
            ("hook data", Box::new(|f| f.hook = vec![1, 2, 3])),
        ];
        for (name, mutate) in cases {
            let mut f = ok_fields();
            mutate(&mut f);
            assert!(check(&f).is_err(), "policy accepted a bad intent: {name}");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_one_burn_intent() {
        let mut m = encode(&ok_fields());
        assert!(parse_message(&m[16..]).is_err(), "missing signing-domain prefix");
        m.push(0);
        assert!(parse_message(&m).is_err(), "trailing bytes");
        assert!(parse_message(b"arbitrary bytes").is_err());
        let mut bad_magic = encode(&ok_fields());
        bad_magic[16] ^= 1;
        assert!(parse_message(&bad_magic).is_err(), "burn intent magic");
    }

    #[test]
    fn duplicate_or_unknown_signer_labels_are_refused() {
        let mut shares = BTreeMap::new();
        shares.insert("A".to_string(), vec![1, 2]);
        shares.insert("B".to_string(), vec![3]);
        shares.insert("C".to_string(), vec![4]);
        let owners = Owners { threshold: 3, shares };
        assert!(resolve_shares(&owners, "B,B,C").is_err(), "B,B,C counted 3 shares");
        assert!(resolve_shares(&owners, "A,A").is_err());
        assert!(resolve_shares(&owners, "A,Z").is_err());
        assert_eq!(resolve_shares(&owners, "B,A").unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn dkg_refuses_to_overwrite_and_writes_owner_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("frost-dkg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        run_dkg(&dir, "A:2,B:1", 2, false).unwrap();
        for f in ["share-1.json", "share-2.json", "share-3.json", "public.json", "group.json", "owners.json"] {
            let mode = fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{f} is {mode:o}");
        }
        let before = fs::read(dir.join("group.json")).unwrap();
        assert!(run_dkg(&dir, "A:2,B:1", 2, false).is_err(), "second dkg must refuse");
        assert_eq!(fs::read(dir.join("group.json")).unwrap(), before, "live delegate key overwritten");
        run_dkg(&dir, "A:2,B:1", 2, true).unwrap();
        assert_ne!(fs::read(dir.join("group.json")).unwrap(), before);
        fs::remove_dir_all(&dir).unwrap();
    }
}
