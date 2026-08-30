// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test doubles for agent/test/ — a mintable 6dp stablecoin and a minimal
/// ERC-4626 vault whose "yield" is simulated by donating assets to it.
/// Neither is deployable infrastructure; they exist so the creature's whole
/// metabolism can run inside an in-process EVM.

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "mock: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "mock: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockVault4626 {
    MockUSDC public immutable usdc;
    uint256 public totalSupply; // shares
    mapping(address => uint256) public balanceOf;

    constructor(MockUSDC _usdc) {
        usdc = _usdc;
    }

    function asset() external view returns (address) {
        return address(usdc);
    }

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares : (shares * totalAssets()) / totalSupply;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return totalSupply == 0 ? assets : (assets * totalSupply) / totalAssets();
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets); // priced before the assets arrive
        require(usdc.transferFrom(msg.sender, address(this), assets), "mock: deposit");
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        returns (uint256 shares)
    {
        require(msg.sender == owner_, "mock: not owner");
        shares = convertToShares(assets);
        if (convertToAssets(shares) < assets) shares += 1; // round against the caller
        require(balanceOf[owner_] >= shares, "mock: shares");
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
        require(usdc.transfer(receiver, assets), "mock: withdraw");
    }
}
