// SPDX-License-Identifier: GPL-3.0-or-later
//
// BUFI-6900 — new, unaudited BUFI code (not part of the Alchemy session-key port, not Circle code).
pragma solidity 0.8.24;

/// @title IBufiSessionRecipientHookPlugin
/// @notice ABI of the hook plugin that gates `BufiSessionKeyPlugin.executeWithSessionKey` recipients against the
///         account's `ColdStorageAddressBookPlugin` set. See `BufiSessionRecipientHookPlugin` for the mechanism.
interface IBufiSessionRecipientHookPlugin {
    /// @notice Emitted when an account binds the hook to its AddressBook plugin (install).
    event AddressBookBound(address indexed account, address indexed addressBook);
    /// @notice Emitted when the binding is cleared (uninstall).
    event AddressBookUnbound(address indexed account, address indexed addressBook);

    /// @notice The install data named the zero address, an address without code, or a contract that does not
    ///         declare `IAddressBookPlugin` through ERC-165.
    error InvalidAddressBook(address addressBook);
    /// @notice The named AddressBook is not an installed plugin of the installing account. The hook only ever
    ///         reads a set that the account's own owner validation manages.
    error AddressBookNotInstalled(address account, address addressBook);

    // The three rejection errors below are signature-identical to `IAddressBookPlugin`'s, so an SDK that already
    // decodes the AddressBook's AA23 revert data decodes this hook's the same way.

    /// @notice `recipient` is not in the account's AddressBook set (or could not be decoded: `address(0)`).
    error UnauthorizedRecipient(address account, address recipient);
    /// @notice A call carrying native value also carried calldata; AddressBook semantics forbid the combination.
    error CallDataIsNotEmpty(address account, address target, uint256 value, bytes data);
    /// @notice A zero-value call targeted an address without code.
    error InvalidTargetCodeLength(address account, address target, uint256 value, bytes data);

    /// @notice The AddressBook plugin the hook reads for `account`; `address(0)` when the hook is not installed.
    function addressBookOf(address account) external view returns (address);
}
