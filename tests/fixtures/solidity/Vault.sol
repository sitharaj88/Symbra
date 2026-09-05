// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Base.sol";
import {IERC20, IERC721 as NFT} from "./tokens/IERC20.sol";
import * as Math from "./math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Vault interface
/// @notice Deposit and withdraw.
interface IVault {
    function deposit(uint256 amount) external payable;
    function balance() external view returns (uint256);
}

/**
 * @title MathLib
 * @dev Small helper library.
 */
library MathLib {
    uint256 internal constant ONE = 1e18;

    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

abstract contract Pausable {
    bool internal _paused;

    modifier whenNotPaused() {
        require(!_paused, "paused");
        _;
    }
}

/// @notice The main vault.
contract Vault is Pausable, IVault, Ownable {
    using MathLib for uint256;

    /// Emitted on deposit.
    event Deposited(address indexed who, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);

    enum Status { Idle, Active, Closed }

    struct Account {
        address owner;
        uint256 balance;
        Status status;
    }

    uint256 public totalSupply;
    mapping(address => Account) private accounts;
    address public immutable treasury;
    Status public status;

    constructor(address _treasury) {
        treasury = _treasury;
    }

    function deposit(uint256 amount) external payable whenNotPaused {
        Account storage a = accounts[msg.sender];
        a.balance = a.balance.add(amount);
        totalSupply = MathLib.add(totalSupply, amount);
        emit Deposited(msg.sender, amount);
        helper();
    }

    function balance() external view returns (uint256) {
        return accounts[msg.sender].balance;
    }

    function helper() private pure {}

    function spawn() public returns (Vault) {
        return new Vault(treasury);
    }
}
