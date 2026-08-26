// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ───────────────────────────────────────────────────────────────────────────
///  MockPumpClaw — stand-ins for testnets, where PumpClaw does not exist.
///
///  PumpClaw is deployed on Base mainnet only. Without these the creature can
///  be deployed to a testnet but never hatched, and since every economic
///  function is gated on `hatched`, it would sit inert forever.
///
///  These mirror the real interfaces exactly, including the 80/20 creator
///  split and the native-ETH payout path. `accrue()` has no counterpart on
///  mainnet: it stands in for trading volume, so a testnet creature can be
///  fed the way the real one is — by its own market — rather than only by
///  hand.
///
///  NEVER deploy these to mainnet. The deploy script uses the real addresses
///  there and refuses to substitute mocks.
/// ───────────────────────────────────────────────────────────────────────────

contract MockPumpClawToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint256 _supply, address holder) {
        name = _name;
        symbol = _symbol;
        totalSupply = _supply;
        balanceOf[holder] = _supply;
        emit Transfer(address(0), holder, _supply);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[f][msg.sender] = a - v;
        }
        _move(f, t, v);
        return true;
    }

    function _move(address f, address t, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        unchecked {
            balanceOf[f] -= v;
            balanceOf[t] += v;
        }
        emit Transfer(f, t, v);
    }
}

contract MockPumpClawLocker {
    uint256 public constant CREATOR_FEE_BPS = 8000; // 80%, as on mainnet
    uint256 public constant BPS = 10000;

    struct Position {
        uint256 positionId;
        address creator;
        bool exists;
    }

    mapping(address => Position) public positions;
    mapping(address => uint256) public pending; // token => unclaimed ETH fees
    address public admin;
    address public factory;

    event FeesClaimed(address indexed token, uint256 amount0, uint256 amount1,
                      uint256 creatorShare0, uint256 creatorShare1);
    event Accrued(address indexed token, uint256 amount);

    constructor(address _admin) {
        admin = _admin;
    }

    function setFactory(address f) external {
        require(factory == address(0), "set");
        factory = f;
    }

    function lockPosition(address token, uint256 positionId, address creator) external {
        require(msg.sender == factory, "only factory");
        require(!positions[token].exists, "locked");
        positions[token] = Position(positionId, creator, true);
    }

    function getPosition(address token) external view returns (uint256, address) {
        Position memory p = positions[token];
        return (p.positionId, p.creator);
    }

    /// @notice Testnet only: stand in for trading fees arriving in the pool.
    function accrue(address token) external payable {
        require(positions[token].exists, "unknown token");
        pending[token] += msg.value;
        emit Accrued(token, msg.value);
    }

    /// @notice Same shape and access as mainnet: permissionless, pays the
    /// recorded creator 80% in native ETH via call.
    function claimFees(address token) external {
        Position memory p = positions[token];
        require(p.exists, "Position not found");
        uint256 total = pending[token];
        if (total == 0) return;          // mainnet is a no-op here too
        pending[token] = 0;

        uint256 creatorShare = (total * CREATOR_FEE_BPS) / BPS;
        uint256 adminShare = total - creatorShare;
        (bool ok, ) = p.creator.call{value: creatorShare}("");
        require(ok, "ETH transfer failed");
        if (adminShare > 0) {
            (bool ok2, ) = admin.call{value: adminShare}("");
            require(ok2, "ETH transfer failed");
        }
        emit FeesClaimed(token, total, 0, creatorShare, 0);
    }

    receive() external payable {}
}

contract MockPumpClawFactory {
    MockPumpClawLocker public immutable lpLocker;
    uint256 public tokenCount;

    event TokenCreated(address indexed token, address indexed creator,
                       string name, string symbol, uint256 positionId,
                       uint256 totalSupply, uint256 initialFdv);

    constructor(address _locker) {
        lpLocker = MockPumpClawLocker(payable(_locker));
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata,
        string calldata,
        uint256 totalSupply,
        uint256 initialFdv,
        address creator
    ) external returns (address token, uint256 positionId) {
        // The real factory puts the whole supply into a locked Uniswap V4
        // position; holding it here is enough to mirror the creator's view.
        token = address(new MockPumpClawToken(name, symbol, totalSupply, address(lpLocker)));
        positionId = ++tokenCount;
        lpLocker.lockPosition(token, positionId, creator);
        emit TokenCreated(token, creator, name, symbol, positionId, totalSupply, initialFdv);
    }
}
