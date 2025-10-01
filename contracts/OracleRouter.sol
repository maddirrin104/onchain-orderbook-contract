// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* ========== Chainlink minimal interface ========== */
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/* ========== Oracle router: map symbol => feed ========== */
contract OracleRouter {
    struct FeedInfo {
        bool exists;
        address feed;
    }

    // key = keccak256(abi.encodePacked(symbol))
    mapping(bytes32 => FeedInfo) public feeds;

    event FeedSet(string symbol, address feed);

    function setFeed(string calldata symbol, address feed) external {
        require(feed != address(0), "invalid feed");
        bytes32 key = keccak256(abi.encodePacked(symbol));
        feeds[key] = FeedInfo({exists: true, feed: feed});
        emit FeedSet(symbol, feed);
    }

    function getLatestPrice(string calldata symbol)
        external
        view
        returns (int256 price, uint8 feedDecimals, uint256 updatedAt)
    {
        bytes32 key = keccak256(abi.encodePacked(symbol));
        FeedInfo memory f = feeds[key];
        require(f.exists, "feed not found");
        AggregatorV3Interface aggr = AggregatorV3Interface(f.feed);
        (, int256 ans, , uint256 upd, ) = aggr.latestRoundData();
        return (ans, aggr.decimals(), upd);
    }

    function getFeedAddress(string calldata symbol) external view returns (address) {
        FeedInfo memory f = feeds[keccak256(abi.encodePacked(symbol))];
        require(f.exists, "feed not found");
        return f.feed;
    }
}
