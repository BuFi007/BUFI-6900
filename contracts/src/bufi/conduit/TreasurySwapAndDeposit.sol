// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC4626Deposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

/**
 * @title TreasurySwapAndDeposit
 * @notice One registered `TreasuryConduit` target that swaps an ERC-3009 stable
 * into Circle USDC and opens the Earn position in the same `execute`.
 *
 * The conduit pulls `tokenIn`, `forceApprove`s this contract, and calls `run`.
 * Swap proceeds land here (the quote's receiver MUST be this address), then
 * `deposit` / `supply` mint to `beneficiary` from the live USDC balance — never
 * from the pre-swap `amountIn`. Leftover `tokenIn` and USDC go back to the
 * conduit so its sweep + share `minOut` still hold.
 */
contract TreasurySwapAndDeposit is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum DestKind {
        Vault4626,
        AaveV3Supply
    }

    address public immutable USDC;

    mapping(address venue => bool allowed) public venues;
    mapping(address dest => bool allowed) public dests;

    event VenueSet(address indexed venue, bool allowed);
    event DestSet(address indexed dest, bool allowed);

    error ZeroAddress();

    error RenounceDisabled();
    error VenueNotRegistered(address venue);
    error DestNotRegistered(address dest);
    error SwapRequired();
    error UnexpectedSwap();
    error SwapFailed(bytes reason);
    error BelowUsdcFloor(uint256 got, uint256 minUsdc);

    constructor(address initialOwner, address usdc_) Ownable(initialOwner) {
        if (usdc_ == address(0)) revert ZeroAddress();
        USDC = usdc_;
    }

    /// @notice Disabled (plan 398, founder 2026-10-08). An ownerless registry is frozen forever, so the
    /// Safe can only ever hand ownership on through the two-step transfer, never drop it.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setVenue(address venue, bool allowed) external onlyOwner {
        if (venue == address(0)) revert ZeroAddress();
        venues[venue] = allowed;
        emit VenueSet(venue, allowed);
    }

    function setDest(address dest, bool allowed) external onlyOwner {
        if (dest == address(0)) revert ZeroAddress();
        dests[dest] = allowed;
        emit DestSet(dest, allowed);
    }

    function run(
        address tokenIn,
        uint256 amountIn,
        address swapTarget,
        bytes calldata swapData,
        DestKind destKind,
        address dest,
        address beneficiary,
        uint256 minUsdc
    ) external nonReentrant {
        if (beneficiary == address(0) || tokenIn == address(0)) revert ZeroAddress();
        if (!dests[dest]) revert DestNotRegistered(dest);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        if (tokenIn != USDC) {
            if (swapTarget == address(0) || !venues[swapTarget]) revert VenueNotRegistered(swapTarget);
            if (swapData.length == 0) revert SwapRequired();
            IERC20(tokenIn).forceApprove(swapTarget, amountIn);
            (bool ok, bytes memory ret) = swapTarget.call(swapData);
            IERC20(tokenIn).forceApprove(swapTarget, 0);
            if (!ok) revert SwapFailed(ret);
        } else if (swapTarget != address(0) || swapData.length != 0) {
            revert UnexpectedSwap();
        }

        uint256 usdcBal = IERC20(USDC).balanceOf(address(this));
        if (usdcBal < minUsdc) revert BelowUsdcFloor(usdcBal, minUsdc);

        IERC20(USDC).forceApprove(dest, usdcBal);
        if (destKind == DestKind.Vault4626) {
            IERC4626Deposit(dest).deposit(usdcBal, beneficiary);
        } else {
            IAaveV3Pool(dest).supply(USDC, usdcBal, beneficiary, 0);
        }
        IERC20(USDC).forceApprove(dest, 0);

        _sweep(IERC20(tokenIn), msg.sender);
        if (tokenIn != USDC) _sweep(IERC20(USDC), msg.sender);
    }

    function _sweep(IERC20 token, address to) private {
        uint256 amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
