// Arc's native-USDC transfer cannot be emulated by a generic Anvil fork.
// Replay only local test state through eth_call. Never sign, send, or override the router/USDC.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const runtimeHash =
	"0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79";
const rpcUrl = "https://rpc.mainnet.arc.io";
const probe = "0x000000000000000000000000000000000000bf10";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function rpc(method, params) {
	assert(["eth_chainId", "eth_call"].includes(method));
	const response = await fetch(rpcUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(response.status, 200, `RPC HTTP ${response.status}`);
	const result = await response.json();
	if (result.error)
		throw new Error(
			`RPC ${result.error.code}: ${String(result.error.message).slice(0, 300)}`,
		);
	return result.result;
}

function words(data, count) {
	assert.match(data, /^0x[0-9a-f]+$/i);
	assert.equal(data.length, 2 + count * 64);
	return Array.from(
		{ length: count },
		(_, i) => `0x${data.slice(2 + i * 64, 66 + i * 64)}`,
	);
}

async function verify(name) {
	assert(["swap", "invoice", "reimbursement"].includes(name));
	const prefix = `${root}/deployments/local/permit2-native-${name}`;
	const input = await readJson(`${prefix}.input.json`);
	const dump = await readJson(`${prefix}.state.json`);
	const readStates = await readJson(`${prefix}.read-state.json`);
	const artifact = await readJson(
		`${root}/out-probe/Permit2RpcProbe.sol/Permit2RpcProbe.json`,
	);
	assert.equal(
		typeof input.minOut,
		"string",
		"token amounts must be exact decimal strings",
	);
	assert.equal(input.runtimeCodeHash, runtimeHash);
	const overrides = {};
	// These two accounts exist only inside the simulation. Other accounts retain their real code.
	for (const address of [input.conduit, input.treasury]) {
		const key = address.toLowerCase();
		assert.match(key, /^0x[0-9a-f]{40}$/);
		const account = (dump.alloc ?? dump.accounts ?? dump)[key];
		assert(account?.code?.startsWith("0x"));
		overrides[key] = { code: account.code };
	}
	for (const [address, encoded] of Object.entries(readStates)) {
		assert.match(address, /^0x[0-9a-f]{40}$/i);
		const state = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
		for (const [slot, value] of Object.entries(state)) {
			assert.match(slot, /^0x[0-9a-f]{64}$/i);
			assert.match(value, /^0x[0-9a-f]{64}$/i);
		}
		const key = address.toLowerCase();
		overrides[key] = { ...overrides[key], stateDiff: state };
	}
	assert(!overrides[probe]);
	overrides[probe] = { code: artifact.deployedBytecode.object };
	assert.equal(await rpc("eth_chainId", []), "0x13b2");
	// Built-in digest of the same release bytes checked with keccak256 by the fork harness.
	assert.equal(
		createHash("sha256")
			.update(
				Buffer.from(
					overrides[input.conduit.toLowerCase()].code.slice(2),
					"hex",
				),
			)
			.digest("hex"),
		"fb5f39f41f2d912645db3efb2103c80f60db87a60f8beb5b58d89827634db735",
	);
	const call = (data) =>
		rpc("eth_call", [
			{ to: probe, data, gas: "0x989680" },
			`0x${BigInt(input.blockNumber).toString(16)}`,
			overrides,
		]);
	const success = words(await call(input.probeData), 5).map(BigInt);
	assert(success[0] >= BigInt(input.minOut));
	assert.equal(success[2], 0n, "router allowance must be cleared");
	assert.equal(success[3], 1n, "original operation must execute");
	assert.equal(success[4], 1n, "original operation replay must be rejected");
	const failed = words(await call(input.belowFloorData), 9);
	assert.equal(BigInt(failed[0]), 0n);
	assert.equal(
		failed[1].slice(0, 10),
		"0xdc6ef75d",
		"must fail specifically at BelowFloor",
	);
	assert.equal(failed[2], failed[3], "input must roll back");
	assert.equal(failed[4], failed[5], "output must roll back");
	assert.equal(failed[6], failed[7], "Permit2 nonce must roll back");
	assert.equal(
		BigInt(failed[8]),
		0n,
		"failed operation must remain unexecuted",
	);
	const proof = {
		mode: "non-persistent eth_call with local test state",
		name,
		chainId: 5042,
		block: input.blockNumber,
		runtimeCodeHash: runtimeHash,
		received: success[0].toString(),
		minimum: input.minOut,
		remainingInput: success[1].toString(),
		allowance: "0",
		replayBlocked: true,
		belowFloorRollback: {
			input: true,
			output: true,
			nonce: true,
			operation: true,
		},
		liveTransaction: false,
	};
	await writeFile(
		`${prefix}.proof.json`,
		`${JSON.stringify(proof, null, 2)}\n`,
	);
	console.log(JSON.stringify(proof));
}

try {
	for (const name of process.argv.slice(2).length
		? process.argv.slice(2)
		: ["swap", "invoice", "reimbursement"])
		await verify(name);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Simulation failed");
	process.exitCode = 1;
}
