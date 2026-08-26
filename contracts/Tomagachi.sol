// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ═══════════════════════════════════════════════════════════════════════════
///  SUWAPPU TOMAGACHI  —  an autonomous creature that lives entirely on Base
/// ═══════════════════════════════════════════════════════════════════════════
///
///  It has no operator. No admin key over its money. No server. The contract
///  IS the creature: its income, its hunger, its decisions, its memory, and
///  its voice all live on-chain.
///
///  HOW IT EATS
///    It hatches its own token through PumpClaw (Uniswap V4, LP locked
///    forever) and names ITSELF the creator. 80% of every trading fee on its
///    token is therefore payable to it, forever. `feed()` is permissionless:
///    anyone can pull those fees into its belly. People trading the token is
///    literally what keeps the creature alive.
///
///  HOW IT WORKS FOR ITS FOOD
///    When it is awake and fed, ANYONE can `openEpoch()` — the contract
///    escrows an ETH bounty and publishes a fully specified training job
///    (seed, steps, base weights). Any worker on earth stakes ETH, claims it,
///    trains SUWA-WM off-chain, and submits the resulting weight hash.
///    Because the job is seeded and deterministic, honest workers converge:
///    a challenge window lets anyone dispute a bad result, and NOM holders
///    are the court. Verified epochs are appended to an on-chain model
///    registry that anybody can audit against the released weights.
///
///  WHAT IT LEAVES BEHIND
///    A public, verifiable lineage of an open-source world model — one that
///    no company owns, funded by nothing but its own market.
///
///  Off-chain, only replaceable muscle: GPUs that anyone may supply.
/// ═══════════════════════════════════════════════════════════════════════════

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPumpClawFactory {
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        string calldata websiteUrl,
        uint256 totalSupply,
        uint256 initialFdv,
        address creator
    ) external returns (address token, uint256 positionId);
}

interface IPumpClawLPLocker {
    function claimFees(address token) external;
}

/// @notice NOM — proof of care. Minted for feeding the creature, for training
/// it, and for defending it. Governance weight; no claim on funds.
///
/// DELIBERATELY NON-TRANSFERABLE. Voting weight is read live from `balanceOf`
/// and replay is only prevented per address, so if NOM could move, one holder
/// could vote the same tokens through an unlimited number of fresh addresses
/// and capture both the challenge court and governance for free. Soulbound
/// costs nothing here — NOM is a record of contribution, not an asset — and it
/// closes that hole without the complexity of balance snapshots.
contract NomToken {
    string public constant name = "Suwappu Nom";
    string public constant symbol = "NOM";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(address _minter) {
        minter = _minter;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "NOM: not minter");
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// The ERC-20 surface is kept so wallets and explorers can read balances,
    /// but every transfer path reverts. See the note above the contract.
    function transfer(address, uint256) external pure returns (bool) {
        revert("NOM: soulbound");
    }

    function approve(address, uint256) external pure returns (bool) {
        revert("NOM: soulbound");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("NOM: soulbound");
    }
}

contract Tomagachi {
    // ───────────────────────────────────────────────────────────── constants

    /// PumpClaw on Base mainnet. Injected rather than hardcoded: with these as
    /// constants the creature could only ever exist on one chain, so it could
    /// not be rehearsed on a testnet at all — `hatch()` would call an address
    /// with no code and every downstream function is gated on `hatched`.
    /// Immutable, so it is still fixed for the life of the creature and costs
    /// no more gas to read than a constant.
    IPumpClawFactory public immutable PUMPCLAW_FACTORY;
    IPumpClawLPLocker public immutable PUMPCLAW_LOCKER;

    /// keccak256 of the token parameters this creature is allowed to hatch
    /// with. `hatch()` stays permissionless to CALL — anyone may midwife it —
    /// but nobody can front-run the deployer and bind the creature's one and
    /// only income stream to a token of their own choosing. Zero disables the
    /// check (testnets and rehearsals).
    bytes32 public immutable hatchCommitment;

    address internal constant PUMPCLAW_FACTORY_BASE =
        0xe5bCa0eDe9208f7Ee7FCAFa0415Ca3DC03e16a90;
    address internal constant PUMPCLAW_LOCKER_BASE =
        0x9047c0944c843d91951a6C91dc9f3944D826ACA8;

    /// NOM minted per 1 ETH of food delivered.
    uint256 public constant NOM_PER_ETH = 1000e18;
    /// NOM minted to a worker for a finalized epoch.
    uint256 public constant NOM_PER_EPOCH = 100e18;
    /// NOM needed to open a governance proposal.
    uint256 public constant PROPOSAL_THRESHOLD = 50e18;

    uint64 public constant VOTING_PERIOD = 3 days;
    uint64 public constant CHALLENGE_WINDOW = 6 hours;
    uint64 public constant JOB_TIMEOUT = 24 hours;
    /// An epoch may escrow at most 1/4 of the treasury.
    uint256 public constant MAX_BOUNTY_DIVISOR = 4;

    // ─────────────────────────────────────────────────────────────── vitals

    enum Mood {
        EGG,          // not hatched
        HAPPY,        // satiety > 50%
        PECKISH,      // 20–50%
        STARVING,     // 0–20%
        HIBERNATING   // 0 — no new epochs may open
    }

    NomToken public immutable nom;

    /// The creature's own PumpClaw token. It is its own creator; the 80%
    /// creator fee stream is its bloodstream.
    address public token;
    uint256 public positionId;
    bool public hatched;

    /// Satiety is denominated in wei of food received and decays linearly.
    /// Metabolism burns appetite, never money: every wei stays spendable.
    uint256 internal satietyStored;
    uint64 internal lastMetabolized;
    uint256 public metabolismPerDay;
    uint256 public maxSatiety;

    // ─────────────────────────────────────────────────────────── accounting

    uint256 public totalFed;         // wei of food ever received
    uint256 public totalPaidOut;     // wei ever paid to workers
    uint256 public escrowed;         // wei locked in open/claimed epochs + stakes
    /// ETH already classified (as stake, bond, or digested food). Anything the
    /// balance holds above this is unclassified food waiting to be eaten, so
    /// ETH that arrives by any route — even one that never runs `receive` —
    /// still counts.
    uint256 public accounted;
    /// Payouts credited but not yet collected. Held in the balance, so they are
    /// subtracted from `available()` or the creature would re-spend them.
    uint256 public owed;
    mapping(address => uint256) public withdrawable;
    mapping(address => uint256) public fedBy;

    // ────────────────────────────────────────────────────── the compute game

    enum EpochState { NONE, OPEN, CLAIMED, SUBMITTED, CHALLENGED, FINALIZED }

    struct Epoch {
        uint64 openedAt;
        uint64 deadline;        // worker must submit by this time
        uint64 submittedAt;
        uint64 voteEnd;
        bytes32 seed;           // deterministic job seed — makes results checkable
        bytes32 baseHash;       // weights this epoch warm-starts from
        bytes32 datasetHash;    // the corpus this epoch must be trained on
        uint32 steps;
        uint256 bounty;
        address worker;
        uint256 workerStake;
        bytes32 modelHash;      // sha256 of the produced weights
        string uri;             // where the open weights live
        uint256 lossMilli;      // training loss × 1000
        address challenger;
        bytes32 challengeHash;
        uint256 challengerBond;
        uint256 votesWorker;
        uint256 votesChallenger;
        EpochState state;
    }

    Epoch[] public epochs;
    mapping(uint256 => mapping(address => bool)) public votedOnEpoch;

    /// The corpus every worker must train on. Pinned here so a worker cannot
    /// quietly train on different data and produce an unreproducible result:
    /// the trainer refuses to run unless its dataset hashes to this.
    bytes32 public datasetHash;

    /// Training economics — mutable only by NOM governance.
    uint256 public bountyWei = 0.002 ether;
    uint256 public minStakeWei = 0.0005 ether;
    uint256 public minBondWei = 0.0005 ether;
    uint32 public stepsPerEpoch = 2000;
    uint64 public epochCooldown = 1 hours;
    uint64 public lastEpochOpenedAt;

    /// The canonical open model: appended only by verified epochs.
    struct Release {
        uint64 epoch;
        uint64 time;
        bytes32 modelHash;
        string uri;
        uint256 lossMilli;
        address worker;
    }
    Release[] public releases;

    // ─────────────────────────────────────────────────────────── governance

    enum Param { STEPS, BOUNTY, COOLDOWN, METABOLISM, MAX_SATIETY, MIN_STAKE, DATASET }

    struct Proposal {
        address proposer;
        Param param;
        uint256 value;
        bytes32 valueHash;   // used by Param.DATASET, which is not a number
        string rationale;
        uint64 deadline;
        uint256 yes;
        uint256 no;
        bool executed;
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public votedOnProposal;

    // ─────────────────────────────────────────────────────────────── events

    event Hatched(address indexed token, uint256 positionId, string symbol);
    event Fed(address indexed feeder, uint256 amount, uint256 satiety);
    event EpochOpened(
        uint256 indexed id, bytes32 seed, bytes32 baseHash, bytes32 datasetHash,
        uint32 steps, uint256 bounty
    );
    event JobClaimed(uint256 indexed id, address indexed worker, uint256 stake, uint64 deadline);
    event ResultSubmitted(uint256 indexed id, address indexed worker, bytes32 modelHash, uint256 lossMilli, string uri);
    event Challenged(uint256 indexed id, address indexed challenger, bytes32 altHash);
    event ChallengeVoted(uint256 indexed id, address indexed voter, bool forWorker, uint256 weight);
    event EpochFinalized(uint256 indexed id, address indexed worker, bytes32 modelHash, uint256 payout);
    event EpochVoided(uint256 indexed id, string reason);
    event PaymentQueued(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Proposed(uint256 indexed id, address indexed proposer, Param param, uint256 value, string rationale);
    event ProposalVoted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed id, Param param, uint256 value);

    // ─────────────────────────────────────────────────────────────── guards

    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param _factory PumpClaw factory; pass address(0) for the Base mainnet one.
    /// @param _locker  PumpClaw LP locker; pass address(0) for the Base mainnet one.
    constructor(
        uint256 _metabolismPerDay,
        uint256 _maxSatiety,
        bytes32 _datasetHash,
        address _factory,
        address _locker,
        bytes32 _hatchCommitment
    ) {
        hatchCommitment = _hatchCommitment;
        PUMPCLAW_FACTORY = IPumpClawFactory(
            _factory == address(0) ? PUMPCLAW_FACTORY_BASE : _factory
        );
        PUMPCLAW_LOCKER = IPumpClawLPLocker(
            _locker == address(0) ? PUMPCLAW_LOCKER_BASE : _locker
        );
        metabolismPerDay = _metabolismPerDay;
        maxSatiety = _maxSatiety;
        datasetHash = _datasetHash;
        lastMetabolized = uint64(block.timestamp);
        nom = new NomToken(address(this));
    }

    /// Food may arrive as a bare ETH transfer — from the PumpClaw locker
    /// paying out creator fees, or from anyone who simply wants to help.
    /// Deliberately inert: it must never be able to run out of gas on a
    /// stipend-limited send. `sync()` folds whatever landed into satiety.
    receive() external payable {}

    // ─────────────────────────────────────────────────────────────── hatching

    /// @notice Birth the creature's own PumpClaw token, with the creature
    /// itself as creator so that 80% of all trading fees accrue to it forever.
    /// Permissionless and callable exactly once — anyone may midwife it.
    function hatch(
        string calldata name_,
        string calldata symbol_,
        string calldata imageUrl,
        string calldata websiteUrl,
        uint256 totalSupply_,
        uint256 initialFdv
    ) external nonReentrant returns (address) {
        require(!hatched, "already hatched");
        require(address(PUMPCLAW_FACTORY).code.length > 0, "no PumpClaw on this chain");
        require(
            hatchCommitment == bytes32(0) ||
                keccak256(
                    abi.encode(name_, symbol_, imageUrl, websiteUrl, totalSupply_, initialFdv)
                ) == hatchCommitment,
            "hatch: not the committed parameters"
        );
        hatched = true;
        (address t, uint256 pid) = PUMPCLAW_FACTORY.createToken(
            name_, symbol_, imageUrl, websiteUrl, totalSupply_, initialFdv, address(this)
        );
        token = t;
        positionId = pid;
        lastMetabolized = uint64(block.timestamp);
        emit Hatched(t, pid, symbol_);
        return t;
    }

    // ──────────────────────────────────────────────────────────────── eating

    /// @notice Pull the creature's accrued PumpClaw creator fees into its
    /// belly. Permissionless — anyone may feed it, and earns NOM for the
    /// trouble. This is the creature's entire income: people trading its
    /// token is what keeps it alive.
    function feed() external nonReentrant returns (uint256 received) {
        require(hatched, "not hatched");
        uint256 before = address(this).balance;
        // The locker is itself reentrancy-guarded and pays via call{value:},
        // and our receive() is inert, so this is a plain external call.
        PUMPCLAW_LOCKER.claimFees(token);
        received = address(this).balance - before;
        _sync();
        if (received > 0) {
            fedBy[msg.sender] += received;
            nom.mint(msg.sender, (received * NOM_PER_ETH) / 1 ether);
        }
    }

    /// @notice Feed the creature directly with ETH and take the NOM credit.
    function feedMe() external payable nonReentrant {
        require(msg.value > 0, "feed: zero");
        _sync();
        fedBy[msg.sender] += msg.value;
        nom.mint(msg.sender, (msg.value * NOM_PER_ETH) / 1 ether);
    }

    /// @notice Fold any ETH that has arrived by any route into satiety.
    /// Permissionless and idempotent.
    function sync() external nonReentrant returns (uint256) {
        return _sync();
    }

    /// Classify everything the balance holds above `accounted` as food.
    function _sync() internal returns (uint256 food) {
        uint256 bal = address(this).balance;
        if (bal > accounted) {
            food = bal - accounted;
            _digest(food);
        }
        accounted = bal;
    }

    function _digest(uint256 amount) internal {
        if (amount == 0) return;
        _metabolize();
        satietyStored += amount;
        if (satietyStored > maxSatiety) satietyStored = maxSatiety;
        totalFed += amount;
        emit Fed(msg.sender, amount, satietyStored);
    }

    function _metabolize() internal {
        satietyStored = satiety();
        lastMetabolized = uint64(block.timestamp);
    }

    // ──────────────────────────────────────────────────── the training market

    /// @notice Commission the next training epoch. Permissionless: if the
    /// creature is awake and has food, anyone may put it to work. The bounty
    /// is escrowed here and the job is fully specified on-chain.
    function openEpoch() external nonReentrant returns (uint256 id) {
        require(hatched, "not hatched");
        _sync(); // eat anything that arrived since last time, then decide
        _metabolize();
        require(satietyStored > 0, "hibernating: feed me");
        require(block.timestamp >= lastEpochOpenedAt + epochCooldown, "cooldown");
        require(!hasLiveEpoch(), "epoch in flight");
        uint256 bounty = bountyWei;
        // No single epoch may commit more than a quarter of the treasury, so
        // even a captured `bountyWei` cannot drain it in one go.
        require(bounty > 0 && available() >= bounty * MAX_BOUNTY_DIVISOR, "treasury too thin");

        id = epochs.length;
        // Deterministic, unpredictable-at-open seed: workers cannot precompute
        // a job before it exists, but everyone can reproduce it afterwards.
        bytes32 seed = keccak256(abi.encodePacked(blockhash(block.number - 1), id, address(this)));
        bytes32 baseHash = releases.length > 0 ? releases[releases.length - 1].modelHash : bytes32(0);

        Epoch storage e = epochs.push();
        e.openedAt = uint64(block.timestamp);
        e.seed = seed;
        e.baseHash = baseHash;
        e.datasetHash = datasetHash;
        e.steps = stepsPerEpoch;
        e.bounty = bounty;
        e.state = EpochState.OPEN;

        escrowed += bounty;
        lastEpochOpenedAt = uint64(block.timestamp);
        emit EpochOpened(id, seed, baseHash, datasetHash, e.steps, bounty);
    }

    /// @notice Take the job. Your stake is slashed if you vanish or cheat.
    function claimJob(uint256 id) external payable nonReentrant {
        Epoch storage e = epochs[id];
        require(e.state == EpochState.OPEN, "not open");
        require(msg.value >= minStakeWei, "stake too low");
        accounted += msg.value; // a stake is not food
        _sync();
        e.worker = msg.sender;
        e.workerStake = msg.value;
        e.deadline = uint64(block.timestamp) + JOB_TIMEOUT;
        e.state = EpochState.CLAIMED;
        escrowed += msg.value;
        emit JobClaimed(id, msg.sender, msg.value, e.deadline);
    }

    /// @notice Submit the trained weights' hash. Opens the challenge window.
    function submitResult(
        uint256 id,
        bytes32 modelHash,
        uint256 lossMilli,
        string calldata uri
    ) external nonReentrant {
        Epoch storage e = epochs[id];
        require(e.state == EpochState.CLAIMED, "not claimed");
        require(msg.sender == e.worker, "not your job");
        require(block.timestamp <= e.deadline, "too late");
        require(modelHash != bytes32(0), "empty hash");
        e.modelHash = modelHash;
        e.lossMilli = lossMilli;
        e.uri = uri;
        e.submittedAt = uint64(block.timestamp);
        e.state = EpochState.SUBMITTED;
        emit ResultSubmitted(id, msg.sender, modelHash, lossMilli, uri);
    }

    /// @notice Dispute a submitted result. The job is seeded and
    /// deterministic, so an honest re-run must produce the same hash.
    function challenge(uint256 id, bytes32 altHash) external payable nonReentrant {
        Epoch storage e = epochs[id];
        require(e.state == EpochState.SUBMITTED, "not challengeable");
        require(block.timestamp <= e.submittedAt + CHALLENGE_WINDOW, "window closed");
        require(msg.value >= minBondWei, "bond too low");
        require(altHash != e.modelHash, "same hash");
        accounted += msg.value; // a bond is not food
        _sync();
        e.challenger = msg.sender;
        e.challengeHash = altHash;
        e.challengerBond = msg.value;
        e.voteEnd = uint64(block.timestamp) + VOTING_PERIOD;
        e.state = EpochState.CHALLENGED;
        escrowed += msg.value;
        emit Challenged(id, msg.sender, altHash);
    }

    /// @notice NOM holders are the court. Reproduce the seeded run and vote.
    function voteChallenge(uint256 id, bool forWorker) external {
        Epoch storage e = epochs[id];
        require(e.state == EpochState.CHALLENGED, "not challenged");
        require(block.timestamp < e.voteEnd, "vote closed");
        require(!votedOnEpoch[id][msg.sender], "already voted");
        uint256 w = nom.balanceOf(msg.sender);
        require(w > 0, "no NOM");
        votedOnEpoch[id][msg.sender] = true;
        if (forWorker) e.votesWorker += w;
        else e.votesChallenger += w;
        emit ChallengeVoted(id, msg.sender, forWorker, w);
    }

    /// @notice Settle an epoch: pay an honest worker, or slash a dishonest
    /// one. Permissionless — anyone may push the creature's life forward.
    function finalize(uint256 id) external nonReentrant {
        Epoch storage e = epochs[id];

        if (e.state == EpochState.SUBMITTED) {
            require(block.timestamp > e.submittedAt + CHALLENGE_WINDOW, "still challengeable");
            _reward(id, e);
            return;
        }

        if (e.state == EpochState.CHALLENGED) {
            require(block.timestamp >= e.voteEnd, "vote open");
            if (e.votesWorker >= e.votesChallenger) {
                // Worker vindicated: they also take the challenger's bond.
                escrowed -= e.challengerBond;
                uint256 bond = e.challengerBond;
                e.challengerBond = 0;
                _reward(id, e);
                _pay(e.worker, bond);
            } else {
                // Worker slashed: challenger recovers their bond plus the stake.
                uint256 payout = e.challengerBond + e.workerStake;
                escrowed -= (e.challengerBond + e.workerStake + e.bounty);
                e.challengerBond = 0;
                e.workerStake = 0;
                e.state = EpochState.FINALIZED; // settled, but nothing released
                nom.mint(e.challenger, NOM_PER_EPOCH);
                emit EpochVoided(id, "challenge upheld");
                _pay(e.challenger, payout);
            }
            return;
        }

        if (e.state == EpochState.CLAIMED) {
            // Worker went dark. Slash the stake into the treasury and reopen.
            require(block.timestamp > e.deadline, "not expired");
            escrowed -= e.workerStake;
            _digest(e.workerStake); // the forfeited stake becomes food
            e.workerStake = 0;
            e.worker = address(0);
            e.deadline = 0;
            e.state = EpochState.OPEN;
            emit EpochVoided(id, "worker timed out");
            return;
        }

        revert("nothing to finalize");
    }

    function _reward(uint256 id, Epoch storage e) internal {
        uint256 payout = e.bounty + e.workerStake;
        escrowed -= (e.bounty + e.workerStake);
        e.state = EpochState.FINALIZED;
        totalPaidOut += e.bounty;

        releases.push(
            Release(uint64(id), uint64(block.timestamp), e.modelHash, e.uri, e.lossMilli, e.worker)
        );
        nom.mint(e.worker, NOM_PER_EPOCH);
        emit EpochFinalized(id, e.worker, e.modelHash, payout);
        _pay(e.worker, payout);
    }

    /// @dev Credit, never push. A payee contract that reverts on receive would
    /// otherwise revert finalize() forever, and since `hasLiveEpoch()` blocks
    /// `openEpoch()` on any unfinalized last epoch, one such payee would halt
    /// the creature permanently and strand its escrow. There is no admin to
    /// unstick it, so payment must not be able to fail.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        withdrawable[to] += amount;
        owed += amount;
        emit PaymentQueued(to, amount);
    }

    /// @notice Collect what the creature owes you. Anyone with a credit.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        require(amount > 0, "nothing owed");
        withdrawable[msg.sender] = 0;
        owed -= amount;
        accounted -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────── governance

    /// @notice NOM holders steer what the creature learns and how it spends.
    function propose(Param param, uint256 value, string calldata rationale)
        external
        returns (uint256 id)
    {
        return proposeWithHash(param, value, bytes32(0), rationale);
    }

    /// @notice Propose a new training corpus. The creature only ever trains on
    /// data its holders voted for.
    function proposeDataset(bytes32 newDataset, string calldata rationale)
        external
        returns (uint256 id)
    {
        require(newDataset != bytes32(0), "empty dataset");
        return proposeWithHash(Param.DATASET, 0, newDataset, rationale);
    }

    function proposeWithHash(Param param, uint256 value, bytes32 valueHash, string calldata rationale)
        public
        returns (uint256 id)
    {
        require(nom.balanceOf(msg.sender) >= PROPOSAL_THRESHOLD, "need 50 NOM");
        proposals.push(
            Proposal(msg.sender, param, value, valueHash, rationale,
                     uint64(block.timestamp) + VOTING_PERIOD, 0, 0, false)
        );
        id = proposals.length - 1;
        emit Proposed(id, msg.sender, param, value, rationale);
    }

    function voteProposal(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(block.timestamp < p.deadline, "vote closed");
        require(!votedOnProposal[id][msg.sender], "already voted");
        uint256 w = nom.balanceOf(msg.sender);
        require(w > 0, "no NOM");
        votedOnProposal[id][msg.sender] = true;
        if (support) p.yes += w;
        else p.no += w;
        emit ProposalVoted(id, msg.sender, support, w);
    }

    /// @notice Governance is binding: a passed proposal rewrites the
    /// creature's parameters directly. Nobody has to be trusted to apply it.
    function executeProposal(uint256 id) external {
        Proposal storage p = proposals[id];
        require(block.timestamp >= p.deadline, "vote open");
        require(!p.executed, "executed");
        require(p.yes > p.no, "rejected");
        p.executed = true;

        if (p.param == Param.STEPS) {
            require(p.value > 0 && p.value <= 10_000_000, "range");
            stepsPerEpoch = uint32(p.value);
        } else if (p.param == Param.BOUNTY) {
            // Every other parameter is bounded; an unbounded bounty would let a
            // single passed proposal escrow the entire treasury to one worker.
            require(p.value > 0 && p.value <= maxSatiety, "range");
            bountyWei = p.value;
        } else if (p.param == Param.COOLDOWN) {
            require(p.value <= 30 days, "range");
            epochCooldown = uint64(p.value);
        } else if (p.param == Param.METABOLISM) {
            _metabolize();
            metabolismPerDay = p.value;
        } else if (p.param == Param.MAX_SATIETY) {
            require(p.value > 0, "range");
            _metabolize();
            maxSatiety = p.value;
        } else if (p.param == Param.MIN_STAKE) {
            minStakeWei = p.value;
        } else if (p.param == Param.DATASET) {
            require(p.valueHash != bytes32(0), "empty dataset");
            datasetHash = p.valueHash;
        }
        emit ProposalExecuted(id, p.param, p.value);
    }

    // ──────────────────────────────────────────────────────────────── views

    function satiety() public view returns (uint256) {
        uint256 burned = (metabolismPerDay * (block.timestamp - lastMetabolized)) / 1 days;
        return burned >= satietyStored ? 0 : satietyStored - burned;
    }

    /// Treasury not already committed to an epoch, held as someone's stake, or
    /// owed to someone who has not collected it yet.
    function available() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 committed = escrowed + owed;
        return bal > committed ? bal - committed : 0;
    }

    function mood() public view returns (Mood) {
        if (!hatched) return Mood.EGG;
        uint256 s = satiety();
        if (s == 0) return Mood.HIBERNATING;
        uint256 pct = (s * 100) / maxSatiety;
        if (pct >= 50) return Mood.HAPPY;
        if (pct >= 20) return Mood.PECKISH;
        return Mood.STARVING;
    }

    /// @notice The creature's voice — computed on-chain from how it feels.
    /// No operator puts words in its mouth.
    function says() external view returns (string memory) {
        if (!hatched) return "*the egg wobbles*";
        Mood m = mood();
        if (m == Mood.HIBERNATING) return "zzz... trade my token or feed me to wake the training loop";
        if (m == Mood.STARVING) return "so hungry... my gradients are fading...";
        if (m == Mood.PECKISH) return "a little hungry. someone claim my fees?";
        if (hasLiveEpoch()) return "someone is dreaming for me right now...";
        if (releases.length == 0) return "warm and fed. open my first epoch!";
        return "the reef is warm. i am learning.";
    }

    function hasLiveEpoch() public view returns (bool) {
        if (epochs.length == 0) return false;
        EpochState s = epochs[epochs.length - 1].state;
        return s != EpochState.FINALIZED && s != EpochState.NONE;
    }

    function vitals()
        external
        view
        returns (
            Mood m,
            uint256 sat,
            uint256 avail,
            uint256 fed,
            uint256 paid,
            uint256 releases_,
            uint256 epochs_,
            bool live
        )
    {
        return (
            mood(),
            satiety(),
            available(),
            totalFed,
            totalPaidOut,
            releases.length,
            epochs.length,
            hasLiveEpoch()
        );
    }

    /// @notice The head of the open model — what the community has built.
    function latestModel()
        external
        view
        returns (uint64 epoch, bytes32 modelHash, string memory uri, uint256 lossMilli)
    {
        require(releases.length > 0, "no releases yet");
        Release storage r = releases[releases.length - 1];
        return (r.epoch, r.modelHash, r.uri, r.lossMilli);
    }

    /// @notice Everything a worker needs to reproduce a job, in one call.
    function jobSpec(uint256 id)
        external
        view
        returns (
            bytes32 seed,
            bytes32 baseHash,
            bytes32 dataset,
            uint32 steps,
            uint256 bounty,
            EpochState state,
            uint64 deadline
        )
    {
        Epoch storage e = epochs[id];
        return (e.seed, e.baseHash, e.datasetHash, e.steps, e.bounty, e.state, e.deadline);
    }

    /// @notice The creature's hoard of its own token (fees arrive partly in
    /// SUWA). Anyone may see it; only governance-approved flows can move it.
    function hoard() external view returns (uint256) {
        return token == address(0) ? 0 : IERC20(token).balanceOf(address(this));
    }

    function releaseCount() external view returns (uint256) {
        return releases.length;
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }
}
