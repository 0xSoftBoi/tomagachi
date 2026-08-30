// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ----------------------------------------------------------------------------
/// TOMAGACHI: THE GAME
///
/// The care layer on top of the creature. The core contract is the metabolism
/// (feed, starve, farm, earn); this one is the reason you open the page every
/// day. Everything here is free except gas, awards only virtual XP, and holds
/// no funds beyond passing a feed through — the game cannot become a casino.
///
///  - CARE ACTIONS  pet (4h), play (8h), groom (24h). Each raises the
///    creature's happiness and earns XP. Happiness decays 10 points a day:
///    an ignored creature is a sad creature, whatever its satiety.
///  - STREAKS       caring on consecutive UTC days builds a streak; every
///    streak day adds +10% care XP, capped at +140%. Miss a day, start over.
///  - MOODS MATTER  playing needs an awake creature. Petting works even in
///    hibernation (you kept it company — double XP). Feeding a STARVING
///    creature pays 3x XP; reviving a HIBERNATING one pays 5x.
///  - LEVELS        all XP from everyone accrues to the creature. Levels are
///    quadratic (level n costs 500·n² total XP) — early levels tumble,
///    later ones are community projects.
///  - BADGES        one-time achievements as an on-chain bitmask. Yes, you
///    can wear "Reviver" forever.
///
/// XP is a score, not a token: it is not transferable, not redeemable, and
/// carries no claim on anything. NOM stays what it always was — feeding
/// through the game mints it 1:1 exactly like feeding directly.
/// ----------------------------------------------------------------------------

interface IGameStable {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ITomagachi {
    function mood() external view returns (uint8);
    function feedFor(address contributor, uint256 amount) external;
    function fedBy(address contributor) external view returns (uint256);
    function stable() external view returns (address);
}

contract TomagachiGame {
    // ----------------------------------------------------------------- moods

    uint8 internal constant MOOD_EGG = 0;
    uint8 internal constant MOOD_STARVING = 3;
    uint8 internal constant MOOD_HIBERNATING = 4;

    // ---------------------------------------------------------------- tuning

    uint64 public constant PET_COOLDOWN = 4 hours;
    uint64 public constant PLAY_COOLDOWN = 8 hours;
    uint64 public constant GROOM_COOLDOWN = 24 hours;

    uint256 public constant HAPPINESS_MAX = 100;
    uint256 public constant HAPPINESS_DECAY_PER_DAY = 10;

    uint256 public constant PET_XP = 5;
    uint256 public constant PLAY_XP = 15;
    uint256 public constant GROOM_XP = 10;
    uint256 public constant FEED_XP_PER_USDC = 10;

    /// Streak bonus: +10% care XP per consecutive day, capped at +140%.
    uint256 public constant STREAK_BONUS_PCT = 10;
    uint256 public constant STREAK_BONUS_CAP_DAYS = 14;

    // ---------------------------------------------------------------- badges

    uint32 public constant BADGE_FIRST_TOUCH = 1 << 0; // first care action
    uint32 public constant BADGE_CLUTCH = 1 << 1;      // fed it while STARVING
    uint32 public constant BADGE_REVIVER = 1 << 2;     // fed it out of HIBERNATION
    uint32 public constant BADGE_WEEK_STREAK = 1 << 3; // 7-day care streak
    uint32 public constant BADGE_MOON_STREAK = 1 << 4; // 30-day care streak
    uint32 public constant BADGE_CENTURION = 1 << 5;   // 100 USDC fed via the game
    uint32 public constant BADGE_WHALE = 1 << 6;       // 1,000 USDC fed via the game
    uint32 public constant BADGE_BESTIE = 1 << 7;      // 100 care actions

    // --------------------------------------------------------------- storage

    ITomagachi public immutable creature;
    IGameStable public immutable stable;

    struct Player {
        uint64 lastPet;
        uint64 lastPlay;
        uint64 lastGroom;
        uint64 lastCareDay;   // floor(timestamp / 1 day) of the latest care action
        uint32 streakDays;
        uint32 careActions;   // pets + plays + grooms, lifetime
        uint32 badges;        // bitmask of BADGE_*
        uint128 xp;           // lifetime XP earned by this player
        uint128 fedViaGame;   // USDC fed through gameFeed (6dp)
        uint128 fedCredited;  // fedBy() already converted to XP (6dp)
    }

    mapping(address => Player) internal players_;
    address[] public playerList;

    uint256 internal happinessStored;
    uint64 internal happinessTouched;

    uint256 public totalXp;   // everyone's XP accrues to the creature
    uint32 public level;      // the creature's level, derived from totalXp

    // ---------------------------------------------------------------- events

    event Petted(address indexed player, uint256 xp, uint256 happiness);
    event Played(address indexed player, uint256 xp, uint256 happiness);
    event Groomed(address indexed player, uint256 xp, uint256 happiness);
    event GameFed(address indexed player, uint256 amount, uint256 xp, uint8 moodBefore);
    event StreakExtended(address indexed player, uint32 days_);
    event BadgeEarned(address indexed player, uint32 badge);
    event LevelUp(uint32 level, uint256 totalXp);

    constructor(address _creature) {
        creature = ITomagachi(_creature);
        stable = IGameStable(ITomagachi(_creature).stable());
        happinessTouched = uint64(block.timestamp);
    }

    // ------------------------------------------------------------- happiness

    /// @notice How loved the creature feels right now (0–100). Decays with
    /// neglect; independent of satiety — a full belly is not a scratched chin.
    function happiness() public view returns (uint256) {
        uint256 decayed =
            (HAPPINESS_DECAY_PER_DAY * (block.timestamp - happinessTouched)) / 1 days;
        return decayed >= happinessStored ? 0 : happinessStored - decayed;
    }

    function _raiseHappiness(uint256 delta) internal returns (uint256 h) {
        h = happiness() + delta;
        if (h > HAPPINESS_MAX) h = HAPPINESS_MAX;
        happinessStored = h;
        happinessTouched = uint64(block.timestamp);
    }

    // ---------------------------------------------------------- care actions

    /// @notice A scratch behind the fins. Works in any mood but EGG — petting
    /// a hibernating creature is keeping it company, and pays double.
    function pet() external {
        uint8 m = creature.mood();
        require(m != MOOD_EGG, "game: still an egg");
        Player storage p = _player(msg.sender);
        require(block.timestamp >= p.lastPet + PET_COOLDOWN, "game: pet cooldown");
        p.lastPet = uint64(block.timestamp);

        uint256 xp = _careXp(p, m == MOOD_HIBERNATING ? PET_XP * 2 : PET_XP);
        uint256 h = _raiseHappiness(5);
        emit Petted(msg.sender, xp, h);
    }

    /// @notice A game of chase through the reef. Needs an awake creature.
    function play() external {
        uint8 m = creature.mood();
        require(m != MOOD_EGG, "game: still an egg");
        require(m != MOOD_HIBERNATING, "game: it is hibernating");
        Player storage p = _player(msg.sender);
        require(block.timestamp >= p.lastPlay + PLAY_COOLDOWN, "game: play cooldown");
        p.lastPlay = uint64(block.timestamp);

        uint256 xp = _careXp(p, PLAY_XP);
        uint256 h = _raiseHappiness(15);
        emit Played(msg.sender, xp, h);
    }

    /// @notice Scrub the algae off. Once a day, deeply appreciated.
    function groom() external {
        uint8 m = creature.mood();
        require(m != MOOD_EGG, "game: still an egg");
        Player storage p = _player(msg.sender);
        require(block.timestamp >= p.lastGroom + GROOM_COOLDOWN, "game: groom cooldown");
        p.lastGroom = uint64(block.timestamp);

        uint256 xp = _careXp(p, GROOM_XP);
        uint256 h = _raiseHappiness(10);
        emit Groomed(msg.sender, xp, h);
    }

    /// Streak bookkeeping + streak-multiplied XP + care badges.
    function _careXp(Player storage p, uint256 base) internal returns (uint256 xp) {
        uint64 today = uint64(block.timestamp / 1 days);
        if (p.lastCareDay == 0 || today > p.lastCareDay + 1) {
            p.streakDays = 1; // first ever, or the streak broke
        } else if (today == p.lastCareDay + 1) {
            p.streakDays += 1;
            emit StreakExtended(msg.sender, p.streakDays);
        }
        p.lastCareDay = today;
        p.careActions += 1;

        uint256 bonusDays =
            p.streakDays > STREAK_BONUS_CAP_DAYS ? STREAK_BONUS_CAP_DAYS : p.streakDays;
        xp = (base * (100 + bonusDays * STREAK_BONUS_PCT)) / 100;
        _award(p, xp);

        _grant(p, BADGE_FIRST_TOUCH);
        if (p.streakDays >= 7) _grant(p, BADGE_WEEK_STREAK);
        if (p.streakDays >= 30) _grant(p, BADGE_MOON_STREAK);
        if (p.careActions >= 100) _grant(p, BADGE_BESTIE);
    }

    // ---------------------------------------------------------- feeding play

    /// @notice Feed through the game and the mood pays: 3x XP for catching it
    /// STARVING, 5x for a revival. NOM mints to you exactly as a direct feed
    /// would — the game holds nothing.
    function gameFeed(uint256 amount) external {
        require(amount > 0, "game: zero");
        uint8 m = creature.mood();

        require(stable.transferFrom(msg.sender, address(this), amount), "game: transfer");
        require(stable.approve(address(creature), amount), "game: approve");
        creature.feedFor(msg.sender, amount);

        Player storage p = _player(msg.sender);
        uint256 mult = m == MOOD_HIBERNATING ? 5 : m == MOOD_STARVING ? 3 : 1;
        uint256 xp = (amount * FEED_XP_PER_USDC * mult) / 1e6;
        _award(p, xp);

        p.fedViaGame += uint128(amount);
        p.fedCredited += uint128(amount); // so claimFeedXp cannot count it twice

        if (m == MOOD_STARVING) _grant(p, BADGE_CLUTCH);
        if (m == MOOD_HIBERNATING) _grant(p, BADGE_REVIVER);
        if (p.fedViaGame >= 100e6) _grant(p, BADGE_CENTURION);
        if (p.fedViaGame >= 1000e6) _grant(p, BADGE_WHALE);

        _raiseHappiness(amount / 1e6); // 1 happiness per USDC, capped inside
        emit GameFed(msg.sender, amount, xp, m);
    }

    /// @notice Fed the creature directly (or via the brain's token sweep)?
    /// Claim your XP here at 1x — the game reads fedBy() and credits only
    /// what it has not already counted.
    function claimFeedXp() external returns (uint256 xp) {
        Player storage p = _player(msg.sender);
        uint256 fed = creature.fedBy(msg.sender);
        require(fed > p.fedCredited, "game: nothing to claim");
        uint256 delta = fed - p.fedCredited;
        p.fedCredited = uint128(fed);

        xp = (delta * FEED_XP_PER_USDC) / 1e6;
        _award(p, xp);
    }

    // ------------------------------------------------------------ xp & level

    /// @notice Total XP a level demands: 500·n². Level 1 is an afternoon;
    /// level 20 is a village.
    function xpForLevel(uint32 n) public pure returns (uint256) {
        return 500 * uint256(n) * uint256(n);
    }

    function _award(Player storage p, uint256 xp) internal {
        p.xp += uint128(xp);
        totalXp += xp;
        while (level < 100 && totalXp >= xpForLevel(level + 1)) {
            level += 1;
            emit LevelUp(level, totalXp);
        }
    }

    function _player(address who) internal returns (Player storage p) {
        p = players_[who];
        if (p.lastCareDay == 0 && p.xp == 0 && p.fedCredited == 0) playerList.push(who);
    }

    function _grant(Player storage p, uint32 badge) internal {
        if (p.badges & badge == 0) {
            p.badges |= badge;
            emit BadgeEarned(msg.sender, badge);
        }
    }

    // ----------------------------------------------------------------- views

    function playerCount() external view returns (uint256) {
        return playerList.length;
    }

    function playerState(address who)
        external
        view
        returns (
            uint128 xp,
            uint32 streakDays,
            uint32 careActions,
            uint32 badges,
            uint128 fedViaGame,
            uint64 nextPetAt,
            uint64 nextPlayAt,
            uint64 nextGroomAt
        )
    {
        Player storage p = players_[who];
        return (
            p.xp,
            p.streakDays,
            p.careActions,
            p.badges,
            p.fedViaGame,
            p.lastPet + PET_COOLDOWN,
            p.lastPlay + PLAY_COOLDOWN,
            p.lastGroom + GROOM_COOLDOWN
        );
    }

    /// @notice Everything the front-end needs in one read.
    function gameState()
        external
        view
        returns (uint256 h, uint32 lvl, uint256 xpTotal, uint256 xpNext, uint256 nPlayers)
    {
        return (happiness(), level, totalXp, xpForLevel(level + 1), playerList.length);
    }
}
