// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice A router that pulls `amountIn` of tokenIn from the caller and mints
/// tokenOut at a fixed rate to `receiver`. `rateBps` can be lowered mid-test to
/// simulate the market moving under the floor; `broken` makes every swap revert.
contract MockSwapRouter {
    uint256 public rateBps = 8_000; // 1 USDC -> 0.80 EURC
    bool public broken;

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function setBroken(bool value) external {
        broken = value;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address receiver)
        external
        returns (uint256 out)
    {
        require(!broken, "router: venue down");
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = amountIn * rateBps / 10_000;
        IMintable(tokenOut).mint(receiver, out);
    }

    /// @dev A "swap" that takes the input and delivers nothing — a rugged route.
    function swallow(address tokenIn, uint256 amountIn) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    }
}
