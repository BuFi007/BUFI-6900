// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/src/Test.sol";
import "../../../src/bufi/gateway-treasury/GatewayTreasury.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock contracts
// ─────────────────────────────────────────────────────────────────────────────

contract MockGatewayWallet {
    address public lastDepositToken;
    uint256 public lastDepositValue;
    address public lastInitiateToken;
    uint256 public lastInitiateValue;
    bool public withdrawCalled;
    address public lastWithdrawToken;

    function deposit(address token, uint256 value) external {
        lastDepositToken = token;
        lastDepositValue = value;
    }

    function depositWithAuthorization(
        address, address, uint256, uint256, uint256, bytes32, bytes calldata
    ) external {}

    function initiateWithdrawal(address token, uint256 value) external {
        lastInitiateToken = token;
        lastInitiateValue = value;
    }

    function withdraw(address token) external {
        withdrawCalled = true;
        lastWithdrawToken = token;
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A mock FiatToken that validates ERC-1271 for contract senders.
contract MockFiatToken {
    string public name_ = "USDC";
    string public version_ = "2";

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event AuthorizationUsed(address from, bytes32 nonce);

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig
    ) external {
        require(block.timestamp > validAfter, "not yet valid");
        require(block.timestamp < validBefore, "expired");

        bytes32 domainSep = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(name_)),
            keccak256(bytes(version_)),
            block.chainid,
            address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(RWA_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));

        // ERC-1271 check when `from` is a contract
        if (from.code.length > 0) {
            bytes4 result = IERC1271(from).isValidSignature(digest, sig);
            require(result == bytes4(0x1626ba7e), "MockFiatToken: invalid sig");
        }
        emit AuthorizationUsed(from, nonce);
    }
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────────────────────────────────────

contract GatewayTreasuryTest is Test {
    // ── EIP-712 type hashes ──────────────────────────────────────────────────

    bytes32 internal constant GATEWAY_DOMAIN_SEP = keccak256(abi.encode(
        keccak256("EIP712Domain(string name,string version)"),
        keccak256("GatewayWallet"),
        keccak256("1")
    ));

    bytes32 internal constant TRANSFER_SPEC_TYPEHASH = keccak256(
        "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,"
        "bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,"
        "bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 internal constant BURN_INTENT_TYPEHASH = keccak256(
        "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)"
        "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,"
        "bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,"
        "bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // ── Common test state ────────────────────────────────────────────────────

    MockGatewayWallet internal gw;
    MockERC20 internal token;
    MockFiatToken internal fiatToken;

    // Configs
    GatewayTreasury internal treasuryA; // weights=[2,1,1] threshold=3
    GatewayTreasury internal treasuryB; // weights=[1,1,1] threshold=2
    GatewayTreasury internal treasuryC; // weights=[5,3,2,2,1] threshold=7

    // Private keys (deterministic)
    uint256[5] internal PKS = [uint256(1), 2, 3, 4, 5];

    // Non-address-shaped bytes32 values used as allowlisted recipients / dest tokens.
    // Exactly 64 hex chars each (32 bytes). High bytes ensure they don't look like EVM addresses.
    bytes32 internal constant DEST_RECIPIENT =
        bytes32(uint256(0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA11));
    bytes32 internal constant DEST_TOKEN =
        bytes32(uint256(0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB11));
    uint32  internal constant DEST_DOMAIN = 5; // Solana

    uint256 internal constant PER_INTENT_CAP = 1_000_000e6;
    uint256 internal constant FEE_CAP = 1_000e6;
    uint32  internal constant TIMELOCK = 1 hours;
    // Arc testnet's Gateway expiry floor is 1,209,599 blocks; the treasury's ceiling sits just above it.
    uint256 internal constant EXPIRY = 1_250_000;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        gw        = new MockGatewayWallet();
        token     = new MockERC20();
        fiatToken = new MockFiatToken();

        // Config A: 3 owners [pk1,pk2,pk3], weights [2,1,1], threshold 3
        {
            address[] memory owners = new address[](3);
            uint16[]  memory wts    = new uint16[](3);
            owners[0] = vm.addr(PKS[0]); owners[1] = vm.addr(PKS[1]); owners[2] = vm.addr(PKS[2]);
            wts[0] = 2; wts[1] = 1; wts[2] = 1;
            treasuryA = _deployTreasury(owners, wts, 3, false);
        }

        // Config B: 3 owners [pk1,pk2,pk3], weights [1,1,1], threshold 2
        {
            address[] memory owners = new address[](3);
            uint16[]  memory wts    = new uint16[](3);
            owners[0] = vm.addr(PKS[0]); owners[1] = vm.addr(PKS[1]); owners[2] = vm.addr(PKS[2]);
            wts[0] = 1; wts[1] = 1; wts[2] = 1;
            treasuryB = _deployTreasury(owners, wts, 2, false);
        }

        // Config C: 5 owners [pk1..pk5], weights [5,3,2,2,1], threshold 7
        {
            address[] memory owners = new address[](5);
            uint16[]  memory wts    = new uint16[](5);
            for (uint256 i = 0; i < 5; i++) owners[i] = vm.addr(PKS[i]);
            wts[0] = 5; wts[1] = 3; wts[2] = 2; wts[3] = 2; wts[4] = 1;
            treasuryC = _deployTreasury(owners, wts, 7, false);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 1  Coalition parity matrix
    // ─────────────────────────────────────────────────────────────────────────

    function test_parity_configA_allSubsets() public {
        uint16[3] memory wts = [uint16(2), 1, 1];
        uint256 n = 3;
        uint256 threshold = 3;
        _testAllSubsets(treasuryA, n, wts, threshold, address(gw), address(token), 3);
    }

    function test_parity_configB_allSubsets() public {
        uint16[3] memory wts = [uint16(1), 1, 1];
        uint256 n = 3;
        uint256 threshold = 2;
        _testAllSubsets(treasuryB, n, wts, threshold, address(gw), address(token), 3);
    }

    function test_parity_configC_allSubsets() public {
        uint16[5] memory wts5 = [uint16(5), 3, 2, 2, 1];
        uint16[] memory wts = new uint16[](5);
        for (uint256 i = 0; i < 5; i++) wts[i] = wts5[i];
        uint256 n = 5;
        uint256 threshold = 7;
        _testAllSubsetsN5(treasuryC, n, wts, threshold, address(gw), address(token));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 2  Policy rejections
    // ─────────────────────────────────────────────────────────────────────────

    function test_reject_wrongHash() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        // Pass a random hash instead of the real digest
        assertEq(treasuryA.isValidSignature(bytes32(uint256(0xdead)), sig), bytes4(0xffffffff));
        // Real hash passes
        assertEq(treasuryA.isValidSignature(hash, sig), bytes4(0x1626ba7e));
    }

    function test_reject_recipientNotAllowlisted() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        // Mutate recipient to something not in the allowlist
        intent.spec.destinationRecipient = bytes32(uint256(0xDEAD));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_allow_solanaRecipient() public {
        // A non-EVM bytes32 recipient that IS in the allowlist should be accepted
        bytes32 solanaRecipient = bytes32(uint256(0xFEEDFACECAFEBABE_FEEDFACECAFEBABE_FEEDFACECAFEBABE_FEEDFACECAFEBABE >> 0));
        // Deploy a treasury with this Solana-style recipient
        address[] memory owners = new address[](3);
        uint16[]  memory wts    = new uint16[](3);
        owners[0] = vm.addr(PKS[0]); owners[1] = vm.addr(PKS[1]); owners[2] = vm.addr(PKS[2]);
        wts[0] = 2; wts[1] = 1; wts[2] = 1;
        bytes32[] memory recipients = new bytes32[](2);
        recipients[0] = DEST_RECIPIENT;
        recipients[1] = solanaRecipient;
        GatewayTreasury t = _deployTreasuryFull(owners, wts, 3, recipients, false);
        // Build intent with Solana recipient
        (bytes32 hash, BurnIntent memory intent) = _buildIntentWith(t, address(token), solanaRecipient, DEST_TOKEN, DEST_DOMAIN, 1e6, 0);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(t.isValidSignature(hash, sig), bytes4(0x1626ba7e), "Solana recipient should be valid");
    }

    function test_reject_domainNotAllowed() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.destinationDomain = 99; // not allowed
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_tokenNotAllowed() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.sourceToken = bytes32(uint256(uint160(address(0xbad10cc))));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_valueOverCap() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.value = PER_INTENT_CAP + 1;
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_valueZero() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.value = 0;
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_maxFeeOverCap() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.maxFee = FEE_CAP + 1;
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_hookDataNonEmpty() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.hookData = "hello";
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_destCallerNotAllowed() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.destinationCaller = bytes32(uint256(uint160(address(0xCAFE))));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_sourceDepositorWrong() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.sourceDepositor = bytes32(uint256(uint160(address(0x1234))));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_sourceSignerWrong() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.sourceSigner = bytes32(uint256(uint160(address(0x5678))));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_sourceContractWrong() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.sourceContract = bytes32(uint256(uint160(address(0xABCD))));
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    function test_reject_unsortedSigners() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        // Get 3 sorted sigs then reverse them
        uint256[] memory pks = _allPrivKeys(3);
        bytes memory sortedSigs = _buildKind0Sig(intent, pks);
        // Reverse the 65-byte chunks
        bytes memory reversedSigs = new bytes(sortedSigs.length);
        uint256 n = sortedSigs.length / 65;
        for (uint256 i = 0; i < n; i++) {
            uint256 src = (n - 1 - i) * 65;
            uint256 dst = i * 65;
            for (uint256 j = 0; j < 65; j++) {
                reversedSigs[dst + j] = sortedSigs[src + j];
            }
        }
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), reversedSigs);
        assertEq(treasuryA.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_reject_duplicateSigner() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        // Sign with pk1 twice
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PKS[0], hash);
        bytes memory dupSigs = abi.encodePacked(r, s, v, r, s, v);
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), dupSigs);
        assertEq(treasuryA.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_reject_nonOwnerSigner() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        // pk999 is not an owner
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(999, hash);
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), abi.encodePacked(r, s, v));
        assertEq(treasuryA.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_reject_malleableS() public {
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        (uint8 v, bytes32 r, bytes32 s_good) = vm.sign(PKS[0], hash);
        // Flip s to upper half
        uint256 secp256k1n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s_bad = bytes32(secp256k1n - uint256(s_good));
        // v flips when s is in upper half
        uint8 v_bad = v == 27 ? 28 : 27;
        bytes memory sigs = abi.encodePacked(r, s_bad, v_bad);
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), sigs);
        assertEq(treasuryA.isValidSignature(hash, sig), bytes4(0xffffffff));
    }

    function test_reject_specVersionNot1() public {
        (,BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.version = 2;
        bytes32 badHash = _rehash(intent);
        bytes memory sig = _buildKind0Sig(intent, _allPrivKeys(3));
        assertEq(treasuryA.isValidSignature(badHash, sig), bytes4(0xffffffff));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 3  Fuzz: isValidSignature never reverts
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_isValidSignature_neverReverts(bytes32 hash, bytes calldata garbage) public {
        bytes4 ret = treasuryA.isValidSignature(hash, garbage);
        assertTrue(ret == bytes4(0x1626ba7e) || ret == bytes4(0xffffffff), "must return one of two values");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 4  Deposits
    // ─────────────────────────────────────────────────────────────────────────

    function test_sweepToGateway() public {
        uint256 amount = 500e6;
        token.mint(address(treasuryA), amount);

        vm.expectEmit(true, false, false, true);
        emit GatewayTreasury.Swept(address(token), amount);

        treasuryA.sweepToGateway(address(token));

        assertEq(gw.lastDepositToken(), address(token));
        assertEq(gw.lastDepositValue(), amount);
    }

    function test_sweepToGateway_zeroBalance_reverts() public {
        vm.expectRevert(GatewayTreasury.ZeroBalance.selector);
        treasuryA.sweepToGateway(address(token));
    }

    function test_kind1_depositWithAuthorization() public {
        // Deploy a treasury using fiatToken as the source token
        address[] memory owners = new address[](3);
        uint16[]  memory wts    = new uint16[](3);
        owners[0] = vm.addr(PKS[0]); owners[1] = vm.addr(PKS[1]); owners[2] = vm.addr(PKS[2]);
        wts[0] = 2; wts[1] = 1; wts[2] = 1;
        GatewayTreasury t = _deployTreasuryWithToken(owners, wts, 3, address(fiatToken));

        uint256 value      = 1e6;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 3600;
        bytes32 nonce      = bytes32(uint256(1));

        // Compute the ERC-3009 digest the fiatToken will compute
        bytes32 domSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USDC"), keccak256("2"),
            block.chainid, address(fiatToken)
        ));
        bytes32 structHash = keccak256(abi.encode(
            RWA_TYPEHASH,
            address(t), address(gw), value, validAfter, validBefore, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));

        // Build kind-1 payload signed by all owners
        bytes memory payload = abi.encode(address(t), address(gw), value, validAfter, validBefore, nonce);
        bytes memory ownerSigs = _signSorted(_allPrivKeys(3), digest);
        bytes memory kind1Sig = abi.encode(uint8(1), payload, ownerSigs);

        // The mock fiatToken will call t.isValidSignature(digest, kind1Sig)
        // msg.sender will be address(fiatToken) — which IS in allowedTokens
        vm.prank(address(fiatToken));
        // Simulate what receiveWithAuthorization does: calls isValidSignature on `from` (=address(t))
        bytes4 result = t.isValidSignature(digest, kind1Sig);
        assertEq(result, bytes4(0x1626ba7e), "kind-1 sig should be valid");
    }

    function test_kind1_wrongTo_rejected() public {
        address[] memory owners = new address[](3);
        uint16[]  memory wts    = new uint16[](3);
        owners[0] = vm.addr(PKS[0]); owners[1] = vm.addr(PKS[1]); owners[2] = vm.addr(PKS[2]);
        wts[0] = 2; wts[1] = 1; wts[2] = 1;
        GatewayTreasury t = _deployTreasuryWithToken(owners, wts, 3, address(fiatToken));

        uint256 value = 1e6;
        address badTo = address(0x9999);
        bytes32 domSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USDC"), keccak256("2"),
            block.chainid, address(fiatToken)
        ));
        bytes32 structHash = keccak256(abi.encode(
            RWA_TYPEHASH, address(t), badTo, value, uint256(0), uint256(type(uint256).max), bytes32(0)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));

        bytes memory payload = abi.encode(address(t), badTo, value, uint256(0), uint256(type(uint256).max), bytes32(0));
        bytes memory ownerSigs = _signSorted(_allPrivKeys(3), digest);
        bytes memory kind1Sig = abi.encode(uint8(1), payload, ownerSigs);

        vm.prank(address(fiatToken));
        assertEq(t.isValidSignature(digest, kind1Sig), bytes4(0xffffffff));
    }

    function test_kind1_nonTokenCaller_rejected() public {
        // msg.sender = this test contract (not in allowedTokens)
        bytes memory payload = abi.encode(
            address(treasuryA), address(gw), uint256(1e6),
            uint256(0), uint256(type(uint256).max), bytes32(0)
        );
        bytes memory kind1Sig = abi.encode(uint8(1), payload, new bytes(65));
        // Call directly — msg.sender is this test contract
        assertEq(treasuryA.isValidSignature(bytes32(0), kind1Sig), bytes4(0xffffffff));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 5  Admin queue
    // ─────────────────────────────────────────────────────────────────────────

    function test_admin_queueNeedsQuorum() public {
        // Only pk2 signs (weight=1, threshold=3) → quorum not met
        bytes memory call_ = abi.encodeWithSelector(GatewayTreasury.setPerIntentCap.selector, uint256(999e6));
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PKS[1], digest); // weight=1 only
        bytes memory sigs = abi.encodePacked(r, s, v);
        vm.expectRevert(GatewayTreasury.QuorumNotReached.selector);
        treasuryA.queueAdmin(call_, 1, sigs);
    }

    function test_admin_executesAfterTimelock() public {
        uint256 newCap = 999e6;
        bytes memory call_ = abi.encodeWithSelector(GatewayTreasury.setPerIntentCap.selector, newCap);
        _queueAndExecute(treasuryA, call_, 1);
        assertEq(treasuryA.perIntentCap(), newCap);
    }

    function test_admin_executeTooEarly_reverts() public {
        bytes memory call_ = abi.encodeWithSelector(GatewayTreasury.setPerIntentCap.selector, uint256(999e6));
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 10);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        treasuryA.queueAdmin(call_, 10, sigs);

        vm.expectRevert(GatewayTreasury.TimelockNotExpired.selector);
        treasuryA.executeAdmin(call_, 10);
    }

    function test_admin_nonceReplay_reverts() public {
        bytes memory call_ = abi.encodeWithSelector(GatewayTreasury.setPerIntentCap.selector, uint256(500e6));
        _queueAndExecute(treasuryA, call_, 42);
        // Try to queue nonce 42 again
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 42);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        vm.expectRevert(GatewayTreasury.NonceAlreadyUsed.selector);
        treasuryA.queueAdmin(call_, 42, sigs);
    }

    function test_admin_cancel_preventsExecution() public {
        bytes memory call_ = abi.encodeWithSelector(GatewayTreasury.setPerIntentCap.selector, uint256(1e6));
        bytes32 callHash = keccak256(call_);
        bytes32 qDigest = _adminDigest(treasuryA, callHash, 77);
        bytes memory qSigs = _signSorted(_allPrivKeys(3), qDigest);
        treasuryA.queueAdmin(call_, 77, qSigs);

        // Cancel
        bytes32 cDigest = _cancelDigest(treasuryA, 77);
        bytes memory cSigs = _signSorted(_allPrivKeys(3), cDigest);
        treasuryA.cancelAdmin(77, cSigs);

        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert(GatewayTreasury.OpAlreadyCancelled.selector);
        treasuryA.executeAdmin(call_, 77);
    }

    function test_admin_setterInvariant_wouldEmptyAllowlist() public {
        // Only one recipient. Try to remove it → should fail inside the self-call.
        bytes memory call_ = abi.encodeWithSelector(
            GatewayTreasury.setAllowedRecipient.selector, DEST_RECIPIENT, false
        );
        // Queue it
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 100);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        treasuryA.queueAdmin(call_, 100, sigs);
        vm.warp(block.timestamp + TIMELOCK + 1);

        // Should revert with SelfCallFailed
        vm.expectRevert();
        treasuryA.executeAdmin(call_, 100);
    }

    function test_admin_invalidSelector_reverts() public {
        // Build a call with a selector not in the whitelist
        bytes memory call_ = abi.encodeWithSelector(bytes4(keccak256("bogus()")));
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 200);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        treasuryA.queueAdmin(call_, 200, sigs);
        vm.warp(block.timestamp + TIMELOCK + 1);

        vm.expectRevert(GatewayTreasury.InvalidCallTarget.selector);
        treasuryA.executeAdmin(call_, 200);
    }

    function test_admin_escapeHatch_initiateWithdrawal() public {
        bytes memory call_ = abi.encodeWithSelector(
            GatewayTreasury.gatewayInitiateWithdrawal.selector, address(token), uint256(1e6)
        );
        _queueAndExecute(treasuryA, call_, 300);
        assertEq(gw.lastInitiateToken(), address(token));
        assertEq(gw.lastInitiateValue(), 1e6);
    }

    function test_admin_escapeHatch_transferToRecipient() public {
        // The escape hatch pays only EVM-shaped allowlisted recipients: allowlist one first.
        address dest = address(0xBEEF);
        bytes32 destB32 = bytes32(uint256(uint160(dest)));
        _queueAndExecute(
            treasuryA, abi.encodeWithSelector(GatewayTreasury.setAllowedRecipient.selector, destB32, true), 399
        );
        token.mint(address(treasuryA), 100e6);
        bytes memory call_ = abi.encodeWithSelector(
            GatewayTreasury.transferToRecipient.selector, address(token), destB32, uint256(50e6)
        );
        _queueAndExecute(treasuryA, call_, 400);
        assertEq(token.balanceOf(dest), 50e6);
    }

    // Regression: /qa review of the Arc Studio output (2026-10-05) — a non-EVM bytes32 recipient (e.g. a Solana
    // key) was truncated to its low 20 bytes and paid; that address belongs to nobody.
    function test_admin_transferToNonEvmRecipient_reverts() public {
        token.mint(address(treasuryA), 100e6);
        bytes memory call_ = abi.encodeWithSelector(
            GatewayTreasury.transferToRecipient.selector, address(token), DEST_RECIPIENT, uint256(50e6)
        );
        bytes32 digest = _adminDigest(treasuryA, keccak256(call_), 401);
        treasuryA.queueAdmin(call_, 401, _signSorted(_allPrivKeys(3), digest));
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert();
        treasuryA.executeAdmin(call_, 401);
        assertEq(token.balanceOf(address(uint160(uint256(DEST_RECIPIENT)))), 0);
    }

    // Regression: a signed burn intent is a bearer instrument; the treasury must refuse expiries past its window.
    function test_reject_expiryBeyondWindow() public {
        (, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.maxBlockHeight = block.number + EXPIRY;
        assertEq(treasuryA.isValidSignature(_rehash(intent), _buildKind0Sig(intent, _allPrivKeys(3))), bytes4(0x1626ba7e));
        intent.maxBlockHeight = block.number + EXPIRY + 1;
        assertEq(treasuryA.isValidSignature(_rehash(intent), _buildKind0Sig(intent, _allPrivKeys(3))), bytes4(0xffffffff));
        intent.maxBlockHeight = type(uint256).max;
        assertEq(treasuryA.isValidSignature(_rehash(intent), _buildKind0Sig(intent, _allPrivKeys(3))), bytes4(0xffffffff));
    }

    // Regression: sourceToken with dirty upper bytes truncated to an allowed token address and passed.
    function test_reject_nonCanonicalSourceToken() public {
        (, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        intent.spec.sourceToken = bytes32(uint256(uint160(address(token))) | (uint256(1) << 200));
        assertEq(treasuryA.isValidSignature(_rehash(intent), _buildKind0Sig(intent, _allPrivKeys(3))), bytes4(0xffffffff));
    }

    function test_admin_transferToUnallowlisted_reverts() public {
        bytes32 badRecipient = bytes32(uint256(0xDEAD_BEEF));
        bytes memory call_ = abi.encodeWithSelector(
            GatewayTreasury.transferToRecipient.selector, address(token), badRecipient, uint256(50e6)
        );
        bytes32 callHash = keccak256(call_);
        bytes32 digest = _adminDigest(treasuryA, callHash, 500);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        treasuryA.queueAdmin(call_, 500, sigs);
        vm.warp(block.timestamp + TIMELOCK + 1);

        vm.expectRevert(); // SelfCallFailed wrapping RecipientNotAllowed
        treasuryA.executeAdmin(call_, 500);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 6  Gas snapshots
    // ─────────────────────────────────────────────────────────────────────────

    function test_gas_isValidSignature_2signers() public {
        // Config A: use pk1(w=2)+pk3(w=1) = 3 >= threshold 3
        uint256[] memory pks = new uint256[](2);
        pks[0] = PKS[0]; pks[1] = PKS[2]; // will be sorted by address inside
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryA, address(token));
        bytes memory sigs = _signSorted(pks, hash);
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), sigs);

        uint256 gasBefore = gasleft();
        bytes4 ret = treasuryA.isValidSignature(hash, sig);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("isValidSignature 2-signer gas", gasUsed);
        assertEq(ret, bytes4(0x1626ba7e));
    }

    function test_gas_isValidSignature_3signers() public {
        // Config B: all 3 owners sign (threshold=2)
        (bytes32 hash, BurnIntent memory intent) = _buildIntent(treasuryB, address(token));
        bytes memory sigs = _signSorted(_allPrivKeys(3), hash);
        bytes memory sig = abi.encode(uint8(0), abi.encode(intent), sigs);

        uint256 gasBefore = gasleft();
        bytes4 ret = treasuryB.isValidSignature(hash, sig);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("isValidSignature 3-signer gas", gasUsed);
        assertEq(ret, bytes4(0x1626ba7e));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _deployTreasury(
        address[] memory owners_,
        uint16[] memory wts_,
        uint256 threshold_,
        bool withFiatToken
    ) internal returns (GatewayTreasury) {
        bytes32[] memory recipients = new bytes32[](1);
        recipients[0] = DEST_RECIPIENT;
        return _deployTreasuryFull(owners_, wts_, threshold_, recipients, withFiatToken);
    }

    function _deployTreasuryFull(
        address[] memory owners_,
        uint16[] memory wts_,
        uint256 threshold_,
        bytes32[] memory recipients_,
        bool withFiatToken
    ) internal returns (GatewayTreasury) {
        uint32[] memory domains = new uint32[](1);
        domains[0] = DEST_DOMAIN;

        address tokenAddr = withFiatToken ? address(fiatToken) : address(token);
        address[] memory tokenAddrs = new address[](1);
        tokenAddrs[0] = tokenAddr;
        string[] memory tNames = new string[](1);
        tNames[0] = "USDC";
        string[] memory tVersions = new string[](1);
        tVersions[0] = "2";
        bytes32[] memory destTokens = new bytes32[](1);
        destTokens[0] = DEST_TOKEN;

        SignerParams memory s = SignerParams({
            owners: owners_,
            weights: wts_,
            thresholdWeight: threshold_,
            gatewayWallet: address(gw)
        });
        PolicyParams memory pol = PolicyParams({
            allowedRecipients: recipients_,
            allowedDestinationDomains: domains,
            tokenAddresses: tokenAddrs,
            tokenNames: tNames,
            tokenVersions: tVersions,
            allowedDestinationTokens: destTokens,
            perIntentCap: PER_INTENT_CAP,
            maxFeeCap: FEE_CAP,
            adminTimelock: TIMELOCK,
            maxExpiryBlocks: EXPIRY
        });
        return new GatewayTreasury(s, pol);
    }

    function _deployTreasuryWithToken(
        address[] memory owners_,
        uint16[] memory wts_,
        uint256 threshold_,
        address tokenAddr_
    ) internal returns (GatewayTreasury) {
        bytes32[] memory recipients = new bytes32[](1);
        recipients[0] = DEST_RECIPIENT;
        uint32[] memory domains = new uint32[](1);
        domains[0] = DEST_DOMAIN;
        address[] memory tokenAddrs = new address[](1);
        tokenAddrs[0] = tokenAddr_;
        string[] memory tNames = new string[](1);
        tNames[0] = "USDC";
        string[] memory tVersions = new string[](1);
        tVersions[0] = "2";
        bytes32[] memory destTokens = new bytes32[](1);
        destTokens[0] = DEST_TOKEN;

        SignerParams memory s = SignerParams({
            owners: owners_,
            weights: wts_,
            thresholdWeight: threshold_,
            gatewayWallet: address(gw)
        });
        PolicyParams memory pol = PolicyParams({
            allowedRecipients: recipients,
            allowedDestinationDomains: domains,
            tokenAddresses: tokenAddrs,
            tokenNames: tNames,
            tokenVersions: tVersions,
            allowedDestinationTokens: destTokens,
            perIntentCap: PER_INTENT_CAP,
            maxFeeCap: FEE_CAP,
            adminTimelock: TIMELOCK,
            maxExpiryBlocks: EXPIRY
        });
        return new GatewayTreasury(s, pol);
    }

    /// @dev Build a valid BurnIntent for the given treasury+token.
    function _buildIntent(GatewayTreasury t, address tok) internal view
        returns (bytes32 hash, BurnIntent memory intent)
    {
        return _buildIntentWith(t, tok, DEST_RECIPIENT, DEST_TOKEN, DEST_DOMAIN, 1e6, 0);
    }

    function _buildIntentWith(
        GatewayTreasury t,
        address tok,
        bytes32 destRecipient,
        bytes32 destToken_,
        uint32 destDomain_,
        uint256 value,
        uint256 maxFee_
    ) internal view returns (bytes32 hash, BurnIntent memory intent) {
        intent = BurnIntent({
            maxBlockHeight: block.number + 100,
            maxFee: maxFee_,
            spec: TransferSpec({
                version: 1,
                sourceDomain: 0,
                destinationDomain: destDomain_,
                sourceContract: bytes32(uint256(uint160(address(gw)))),
                destinationContract: bytes32(0),
                sourceToken: bytes32(uint256(uint160(tok))),
                destinationToken: destToken_,
                sourceDepositor: bytes32(uint256(uint160(address(t)))),
                destinationRecipient: destRecipient,
                sourceSigner: bytes32(uint256(uint160(address(t)))),
                destinationCaller: bytes32(0),
                value: value,
                salt: bytes32(0),
                hookData: ""
            })
        });
        hash = _hashIntent(intent);
    }

    function _hashIntent(BurnIntent memory intent) internal pure returns (bytes32) {
        bytes32 specHash = keccak256(abi.encode(
            TRANSFER_SPEC_TYPEHASH,
            intent.spec.version,
            intent.spec.sourceDomain,
            intent.spec.destinationDomain,
            intent.spec.sourceContract,
            intent.spec.destinationContract,
            intent.spec.sourceToken,
            intent.spec.destinationToken,
            intent.spec.sourceDepositor,
            intent.spec.destinationRecipient,
            intent.spec.sourceSigner,
            intent.spec.destinationCaller,
            intent.spec.value,
            intent.spec.salt,
            keccak256(intent.spec.hookData)
        ));
        bytes32 intentHash = keccak256(abi.encode(
            BURN_INTENT_TYPEHASH, intent.maxBlockHeight, intent.maxFee, specHash
        ));
        return keccak256(abi.encodePacked("\x19\x01", GATEWAY_DOMAIN_SEP, intentHash));
    }

    function _rehash(BurnIntent memory intent) internal pure returns (bytes32) {
        return _hashIntent(intent);
    }

    /// @dev Build kind-0 signature bytes from given private keys.
    function _buildKind0Sig(BurnIntent memory intent, uint256[] memory pks) internal pure returns (bytes memory) {
        bytes32 hash = _hashIntent(intent);
        bytes memory ownerSigs = _signSorted(pks, hash);
        return abi.encode(uint8(0), abi.encode(intent), ownerSigs);
    }

    /// @dev Sort private keys by recovered address ascending, then pack 65-byte sigs.
    function _signSorted(uint256[] memory pks, bytes32 hash) internal pure returns (bytes memory packed) {
        // Bubble sort by vm.addr
        address[] memory addrs = new address[](pks.length);
        for (uint256 i = 0; i < pks.length; i++) addrs[i] = vm.addr(pks[i]);
        for (uint256 i = 0; i < pks.length; i++) {
            for (uint256 j = i + 1; j < pks.length; j++) {
                if (addrs[i] > addrs[j]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (pks[i], pks[j])   = (pks[j], pks[i]);
                }
            }
        }
        for (uint256 i = 0; i < pks.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], hash);
            packed = abi.encodePacked(packed, r, s, v);
        }
    }

    /// @dev Get all private keys for n owners.
    function _allPrivKeys(uint256 n) internal view returns (uint256[] memory pks) {
        pks = new uint256[](n);
        for (uint256 i = 0; i < n; i++) pks[i] = PKS[i];
    }

    /// @dev Compute the admin queue EIP-712 digest.
    function _adminDigest(GatewayTreasury t, bytes32 callHash, uint256 nonce) internal view returns (bytes32) {
        bytes32 domSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("GatewayTreasury"), keccak256("1"),
            block.chainid, address(t)
        ));
        bytes32 structHash = keccak256(abi.encode(
            keccak256("AdminOp(bytes32 callHash,uint256 nonce)"), callHash, nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
    }

    function _cancelDigest(GatewayTreasury t, uint256 nonce) internal view returns (bytes32) {
        bytes32 domSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("GatewayTreasury"), keccak256("1"),
            block.chainid, address(t)
        ));
        bytes32 structHash = keccak256(abi.encode(
            keccak256("CancelAdminOp(uint256 nonce)"), nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
    }

    /// @dev Helper to queue+warp+execute an admin call on treasury.
    function _queueAndExecute(GatewayTreasury t, bytes memory call_, uint256 nonce) internal {
        bytes32 callHash = keccak256(call_);
        bytes32 digest   = _adminDigest(t, callHash, nonce);
        bytes memory sigs = _signSorted(_allPrivKeys(3), digest);
        t.queueAdmin(call_, nonce, sigs);
        vm.warp(block.timestamp + TIMELOCK + 1);
        t.executeAdmin(call_, nonce);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Coalition inner loops (separated to avoid stack depth)
    // ─────────────────────────────────────────────────────────────────────────

    function _testAllSubsets(
        GatewayTreasury t,
        uint256 n,
        uint16[3] memory wts3,
        uint256 threshold_,
        address gw_,
        address tok_,
        uint256 ownerCount
    ) internal {
        uint16[] memory wts = new uint16[](n);
        for (uint256 i = 0; i < n; i++) wts[i] = wts3[i];
        _testAllSubsetsN(t, n, wts, threshold_, gw_, tok_, ownerCount);
    }

    function _testAllSubsetsN5(
        GatewayTreasury t,
        uint256 n,
        uint16[] memory wts,
        uint256 threshold_,
        address gw_,
        address tok_
    ) internal {
        _testAllSubsetsN(t, n, wts, threshold_, gw_, tok_, n);
    }

    function _testAllSubsetsN(
        GatewayTreasury t,
        uint256 n,
        uint16[] memory wts,
        uint256 threshold_,
        address, // gw_ unused
        address tok_,
        uint256 // ownerCount unused
    ) internal {
        uint256 total = 1 << n;
        for (uint256 mask = 1; mask < total; mask++) {
            // Compute expected weight
            uint256 subsetWeight = 0;
            uint256 cnt = 0;
            for (uint256 i = 0; i < n; i++) {
                if (mask & (1 << i) != 0) { subsetWeight += wts[i]; cnt++; }
            }
            bool expected = subsetWeight >= threshold_;

            // Collect private keys for subset
            uint256[] memory pks = new uint256[](cnt);
            uint256 idx = 0;
            for (uint256 i = 0; i < n; i++) {
                if (mask & (1 << i) != 0) { pks[idx++] = PKS[i]; }
            }

            // Build intent and sign
            (bytes32 hash, BurnIntent memory intent) = _buildIntentWith(
                t, tok_, DEST_RECIPIENT, DEST_TOKEN, DEST_DOMAIN, 1e6, 0
            );
            bytes memory ownerSigs = _signSorted(pks, hash);
            bytes memory sig = abi.encode(uint8(0), abi.encode(intent), ownerSigs);

            bytes4 result = t.isValidSignature(hash, sig);
            if (expected) {
                assertEq(result, bytes4(0x1626ba7e),
                    string(abi.encodePacked("mask=", vm.toString(mask), " should WIN")));
            } else {
                assertEq(result, bytes4(0xffffffff),
                    string(abi.encodePacked("mask=", vm.toString(mask), " should LOSE")));
            }
        }
    }
}
