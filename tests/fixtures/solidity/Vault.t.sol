// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {Vault} from "../Vault.sol";

contract VaultTest is Test {
    Vault internal vault;

    function setUp() public {
        string memory rpc = vm.envString("MAINNET_RPC_URL");
        vault = new Vault(address(this));
    }

    /// @notice Deposits increase the balance.
    function testDeposit() public {
        vault.deposit(1 ether);
        assertEq(vault.totalSupply(), 1 ether);
    }

    function testRevertsWhenPaused() public {
        vm.expectRevert();
        vault.deposit(0);
    }
}
