// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function decimals() external view returns (uint8);
    function balanceOf(address a) external view returns (uint256);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function transfer(address t, uint256 v) external returns (bool);
    function allowance(address o, address s) external view returns (uint256);
    function approve(address s, uint256 v) external returns (bool);
}

contract SimpleVault {
    // token => user => balance (đã deposit)
    mapping(address => mapping(address => uint256)) public balanceOf;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);

    function deposit(address token, uint256 amount) external {
        require(amount > 0, "amount=0");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        balanceOf[token][msg.sender] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external {
        require(balanceOf[token][msg.sender] >= amount, "insufficient");
        balanceOf[token][msg.sender] -= amount;
        require(IERC20(token).transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, token, amount);
    }

    // dùng bởi OrderBook để move giữa users
    function debit(address token, address user, uint256 amount) external {
        require(balanceOf[token][user] >= amount, "insufficient");
        balanceOf[token][user] -= amount;
        // số tiền bị trừ sẽ do caller (OrderBook) quản lý tiếp
    }

    function credit(address token, address user, uint256 amount) external {
        balanceOf[token][user] += amount;
    }
}
