// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ICrossChainTokenService} from "../../src/bufi/conduit/TreasuryBridgeConduit.sol";

/// @notice CCTP V2 TokenMessengerV2 reduced to what the conduit relies on:
/// `transferFrom(msg.sender, this, amount)` of the burn token (the real one
/// moves it to the TokenMinter and burns it), the same `maxFee < amount` and
/// non-zero-recipient guards, and a record of every argument. Modes let a test
/// make it skim (take less than asked), revert, or re-enter the caller.
contract MockTokenMessengerV2 {
    struct Call {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        address caller;
    }

    Call public last;
    uint256 public calls;
    uint256 public skim; // take `amount - skim`
    bool public broken;
    address public reenterTarget;
    bytes public reenterData;

    function setSkim(uint256 v) external {
        skim = v;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(!broken, "messenger: down");
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        last = Call(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            msg.sender
        );
        calls++;
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount - skim);
    }
}

/// @notice The per-token TokenManager CCTS approves against: it pulls the
/// bridged amount from the original sender, on the service's instruction.
contract MockTokenManager {
    address public immutable service;

    constructor() {
        service = msg.sender;
    }

    function take(address token, address from, uint256 amount) external {
        require(msg.sender == service, "manager: only service");
        IERC20(token).transferFrom(from, address(this), amount);
    }
}

/// @notice CrossChainTokenService with the exact `crossChainTransfer` ABI from
/// circle-fin/adapter-viem-v2 v1.19.0. It pulls through its TokenManager,
/// charges `fee` of the native value, refunds any excess to
/// `claim.refundAddress` like the real FeeManager, and records everything.
contract MockCrossChainTokenService {
    struct Call {
        bytes32 tokenId;
        uint256 amount;
        uint32 destinationDomain;
        bytes destinationAddress;
        bytes32 destinationCaller;
        uint32 minFinalityThreshold;
        bytes signedQuote;
        address refundAddress;
        bool autoExecuteHookData;
        bytes hookData;
        uint256 value;
        address caller;
    }

    MockTokenManager public immutable manager;
    mapping(bytes32 tokenId => address token) public tokenOf;
    Call internal _last;
    uint256 public calls;
    uint256 public fee;
    uint256 public skim;
    address public reenterTarget;
    bytes public reenterData;

    constructor() {
        manager = new MockTokenManager();
    }

    function setToken(bytes32 tokenId, address token) external {
        tokenOf[tokenId] = token;
    }

    function setFee(uint256 v) external {
        fee = v;
    }

    function setSkim(uint256 v) external {
        skim = v;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function resolveTokenManager(bytes32 tokenId) external view returns (address) {
        return tokenOf[tokenId] == address(0) ? address(0) : address(manager);
    }

    function last() external view returns (Call memory) {
        return _last;
    }

    function crossChainTransfer(
        bytes32 tokenId,
        uint256 amount,
        uint32 destinationDomain,
        bytes calldata destinationAddress,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        ICrossChainTokenService.QuoteClaim calldata claim,
        bool autoExecuteHookData,
        bytes calldata hookData
    ) external payable {
        require(tokenOf[tokenId] != address(0), "ccts: unknown token");
        require(msg.value >= fee, "ccts: fee");
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        _last = Call(
            tokenId,
            amount,
            destinationDomain,
            destinationAddress,
            destinationCaller,
            minFinalityThreshold,
            claim.signedQuote,
            claim.refundAddress,
            autoExecuteHookData,
            hookData,
            msg.value,
            msg.sender
        );
        calls++;
        manager.take(tokenOf[tokenId], msg.sender, amount - skim);
        uint256 excess = msg.value - fee;
        if (excess > 0 && claim.refundAddress != address(0)) {
            (bool ok,) = claim.refundAddress.call{value: excess}("");
            require(ok, "ccts: refund");
        }
    }
}

/// @notice A registered venue that tries to re-enter the conduit mid-swap.
contract MockReentrantVenue {
    address public target;
    bytes public data;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function swap() external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
