// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OracleRouter.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/* ========== Library: FixedPoint helpers ========== */
library FP {
    uint256 internal constant WAD = 1e18;
    function mulWad(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x * y) / WAD;
    }
    function divWad(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x * WAD) / y;
    }
}

/* ========== Core DEX with on-chain orderbook ========== */
contract OnchainOrderBook {
    using FP for uint256;

    enum Side { BUY, SELL }

    struct Pair {
        string symbol;         // ví dụ: "ETH - USD"
        uint8 priceDecimals;   // ví dụ 18 = price * 1e18
        uint8 baseDecimals;    // decimals tài sản cơ sở
        uint8 quoteDecimals;   // decimals tài sản định giá
        IERC20 baseToken;
        IERC20 quoteToken;
        bool exists;
    }

    // user balances per pair (vault đơn giản)
    mapping(uint256 => mapping(address => uint256)) public baseBalances;   // pairId => user => base
    mapping(uint256 => mapping(address => uint256)) public quoteBalances;  // pairId => user => quote

    struct Order {
        uint256 id;
        address trader;
        Side side;
        uint256 price;     // scaled by priceDecimals
        uint256 amount;    // base amount, scaled by baseDecimals
        uint256 remaining; // base amount còn lại
        uint256 timestamp;
        bool active;
        uint256 lockedBase;   // chỉ dùng cho SELL
        uint256 lockedQuote;  // chỉ dùng cho BUY
    }


    struct Trade {
        uint256 ts;
        uint256 price;   // scaled by priceDecimals
        uint256 amount;  // base amount, scaled by baseDecimals (filled)
        address maker;
        address taker;
        Side takerSide;  // side của taker order
    }

    /* ===== Storage ===== */
    OracleRouter public oracle;
    uint256 public nextPairId = 1;
    uint256 public nextOrderId = 1;

    // pairId => Pair
    mapping(uint256 => Pair) public pairs;

    // pairId => last price + timestamp
    mapping(uint256 => uint256) public lastPrice;
    mapping(uint256 => uint256) public lastPriceTime;

    // Order storage
    mapping(uint256 => Order) public orders; // orderId => Order

    // OrderBook theo price level (đã gộp size)
    mapping(uint256 => mapping(uint256 => uint256)) public bidLevels; // pairId => price => total base
    mapping(uint256 => mapping(uint256 => uint256)) public askLevels;

    // Danh sách giá (duy nhất) đã sắp xếp
    mapping(uint256 => uint256[]) public bidPrices; // DESC
    mapping(uint256 => uint256[]) public askPrices; // ASC
    mapping(uint256 => mapping(uint256 => bool)) internal hasBidPrice;
    mapping(uint256 => mapping(uint256 => bool)) internal hasAskPrice;

    // FIFO queue orderId theo từng price level
    mapping(uint256 => mapping(uint256 => uint256[])) internal bidQueues; // pairId => price => orderIds[]
    mapping(uint256 => mapping(uint256 => uint256[])) internal askQueues;

    // Recent trades ring buffer
    uint256 public constant MAX_RECENT_TRADES = 64;
    mapping(uint256 => Trade[MAX_RECENT_TRADES]) internal recentTrades;
    mapping(uint256 => uint256) internal recentTradeCount;

    /* ===== Events ===== */
    event PairAdded(uint256 indexed pairId, string symbol, uint8 priceDecimals, uint8 baseDecimals, uint8 quoteDecimals);
    event OrderPlaced(uint256 indexed pairId, uint256 indexed orderId, address indexed trader, Side side, uint256 price, uint256 amount);
    event OrderPartiallyFilled(uint256 indexed pairId, uint256 indexed orderId, uint256 fillAmount, uint256 remaining);
    event OrderFilled(uint256 indexed pairId, uint256 indexed orderId);
    event OrderCanceled(uint256 indexed pairId, uint256 indexed orderId);
    event TradeExecuted(uint256 indexed pairId, uint256 price, uint256 amount, address maker, address taker, Side takerSide);

    event BaseDeposited(uint256 indexed pairId, address indexed user, uint256 amount);
    event QuoteDeposited(uint256 indexed pairId, address indexed user, uint256 amount);
    event BaseWithdrawn(uint256 indexed pairId, address indexed user, uint256 amount);
    event QuoteWithdrawn(uint256 indexed pairId, address indexed user, uint256 amount);


    constructor(address _oracleRouter) {
        oracle = OracleRouter(_oracleRouter);
    }

    /* ===== Admin: add pairs ===== */
    function addPair(
        string calldata symbol,
        uint8 priceDecimals,
        uint8 baseDecimals,
        uint8 quoteDecimals,
        address baseToken,
        address quoteToken
    ) external returns (uint256 pairId) {
        require(baseToken != address(0) && quoteToken != address(0), "zero addr");

        pairId = nextPairId++;
        pairs[pairId] = Pair({
            symbol: symbol,
            priceDecimals: priceDecimals,
            baseDecimals: baseDecimals,
            quoteDecimals: quoteDecimals,
            baseToken: IERC20(baseToken),
            quoteToken: IERC20(quoteToken),
            exists: true
        });

        emit PairAdded(pairId, symbol, priceDecimals, baseDecimals, quoteDecimals);
    }


    /* ===== Helpers for price arrays ===== */
    function _insertBidPrice(uint256 pairId, uint256 price) internal {
        if (hasBidPrice[pairId][price]) return;
        uint256[] storage arr = bidPrices[pairId];
        uint256 i = arr.length;
        arr.push(price);
        // giữ thứ tự giảm dần
        while (i > 0 && arr[i-1] < price) {
            arr[i] = arr[i-1];
            i--;
        }
        arr[i] = price;
        hasBidPrice[pairId][price] = true;
    }

    function _insertAskPrice(uint256 pairId, uint256 price) internal {
        if (hasAskPrice[pairId][price]) return;
        uint256[] storage arr = askPrices[pairId];
        uint256 i = arr.length;
        arr.push(price);
        // giữ thứ tự tăng dần
        while (i > 0 && arr[i-1] > price) {
            arr[i] = arr[i-1];
            i--;
        }
        arr[i] = price;
        hasAskPrice[pairId][price] = true;
    }

    function _cleanupTop(uint256 pairId) internal {
        // Xoá các mức giá đầu nếu size=0 (lazy cleanup)
        uint256[] storage bids = bidPrices[pairId];
        while (bids.length > 0 && bidLevels[pairId][bids[0]] == 0) {
            hasBidPrice[pairId][bids[0]] = false;
            for (uint256 i = 0; i + 1 < bids.length; i++) bids[i] = bids[i + 1];
            bids.pop();
        }
        uint256[] storage asks = askPrices[pairId];
        while (asks.length > 0 && askLevels[pairId][asks[0]] == 0) {
            hasAskPrice[pairId][asks[0]] = false;
            for (uint256 j = 0; j + 1 < asks.length; j++) asks[j] = asks[j + 1];
            asks.pop();
        }
    }

    /* ===== Place/Cancel Orders ===== */
    function placeLimitOrder(
        uint256 pairId,
        Side side,
        uint256 price,   // scaled by priceDecimals
        uint256 amount   // scaled by baseDecimals
    ) external returns (uint256 orderId) {
        require(pairs[pairId].exists, "pair not found");
        require(price > 0 && amount > 0, "invalid params");

        Pair storage pair = pairs[pairId];

        uint256 lockedBase;
        uint256 lockedQuote;

        if (side == Side.BUY) {
            // Cần khóa tối đa quote = price * amount
            uint256 costQuote = _quoteAmount(price, amount);
            require(quoteBalances[pairId][msg.sender] >= costQuote, "insuff quote");
            quoteBalances[pairId][msg.sender] -= costQuote;
            lockedQuote = costQuote;
        } else {
            // SELL: khóa base amount
            require(baseBalances[pairId][msg.sender] >= amount, "insuff base");
            baseBalances[pairId][msg.sender] -= amount;
            lockedBase = amount;
        }

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            trader: msg.sender,
            side: side,
            price: price,
            amount: amount,
            remaining: amount,
            timestamp: block.timestamp,
            active: true,
            lockedBase: lockedBase,
            lockedQuote: lockedQuote
        });
        emit OrderPlaced(pairId, orderId, msg.sender, side, price, amount);

        if (side == Side.BUY) {
            // Cross với ask
            while (orders[orderId].active && askPrices[pairId].length > 0 && askPrices[pairId][0] <= price) {
                uint256 bestAsk = askPrices[pairId][0];
                _matchAtPrice(pairId, orderId, Side.BUY, bestAsk);
                _cleanupTop(pairId);
            }
            if (orders[orderId].active) {
                _insertBidPrice(pairId, price);
                bidLevels[pairId][price] += orders[orderId].remaining;
                bidQueues[pairId][price].push(orderId);
            }
        } else {
            // Cross với bid
            while (orders[orderId].active && bidPrices[pairId].length > 0 && bidPrices[pairId][0] >= price) {
                uint256 bestBid = bidPrices[pairId][0];
                _matchAtPrice(pairId, orderId, Side.SELL, bestBid);
                _cleanupTop(pairId);
            }
            if (orders[orderId].active) {
                _insertAskPrice(pairId, price);
                askLevels[pairId][price] += orders[orderId].remaining;
                askQueues[pairId][price].push(orderId);
            }
        }
    }


    function cancelOrder(uint256 pairId, uint256 orderId) external {
        Order storage o = orders[orderId];
        require(o.active, "not active");
        require(o.trader == msg.sender, "not owner");

        o.active = false;

        if (o.side == Side.BUY) {
            uint256 lvl = bidLevels[pairId][o.price];
            if (lvl >= o.remaining) bidLevels[pairId][o.price] = lvl - o.remaining;
        } else {
            uint256 lvl2 = askLevels[pairId][o.price];
            if (lvl2 >= o.remaining) askLevels[pairId][o.price] = lvl2 - o.remaining;
        }

        // refund phần locked còn lại (base / quote)
        _refundLocked(pairId, o);

        emit OrderCanceled(pairId, orderId);
        _cleanupTop(pairId);
    }


    function _matchAtPrice(uint256 pairId, uint256 takerId, Side takerSide, uint256 priceLevel) internal {
        Order storage taker = orders[takerId];
        require(taker.active, "taker inactive");

        uint256[] storage q = (takerSide == Side.BUY) ? askQueues[pairId][priceLevel] : bidQueues[pairId][priceLevel];

        Pair storage pair = pairs[pairId];
        uint256 idx = 0;
        while (taker.active && idx < q.length) {
            uint256 makerId = q[idx];
            Order storage maker = orders[makerId];
            if (!maker.active || maker.remaining == 0) { idx++; continue; }

            uint256 fill = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;

            // Cập nhật remaining
            taker.remaining -= fill;
            maker.remaining -= fill;

            // Giá khớp = priceLevel
            uint256 tradePrice = priceLevel;
            uint256 quoteAtTrade = _quoteAmount(tradePrice, fill);

            // Buyer / Seller & xử lý price improvement
            if (takerSide == Side.BUY) {
                // taker = BUY, maker = SELL
                Order storage buyOrder = taker;
                Order storage sellOrder = maker;

                uint256 quoteAtLimit = _quoteAmount(buyOrder.price, fill);
                require(buyOrder.lockedQuote >= quoteAtLimit, "BUY: lockedQuote underflow");

                // giảm locked theo limit price
                buyOrder.lockedQuote -= quoteAtLimit;

                // seller nhận quote theo giá trade
                quoteBalances[pairId][sellOrder.trader] += quoteAtTrade;

                // refund cho buyer nếu có price improvement
                if (quoteAtLimit > quoteAtTrade) {
                    uint256 refund = quoteAtLimit - quoteAtTrade;
                    quoteBalances[pairId][buyOrder.trader] += refund;
                }

                // base: từ seller sang buyer
                require(sellOrder.lockedBase >= fill, "SELL: lockedBase underflow");
                sellOrder.lockedBase -= fill;
                baseBalances[pairId][buyOrder.trader] += fill;

                // Update tổng level
                askLevels[pairId][priceLevel] -= fill;
            } else {
                // taker = SELL, maker = BUY
                Order storage sellOrder = taker;
                Order storage buyOrder = maker;

                uint256 quoteAtLimit = _quoteAmount(buyOrder.price, fill);
                require(buyOrder.lockedQuote >= quoteAtLimit, "BUY: lockedQuote underflow");

                buyOrder.lockedQuote -= quoteAtLimit;

                // seller nhận quote theo giá trade
                quoteBalances[pairId][sellOrder.trader] += quoteAtTrade;

                // refund cho buyer nếu giá trade < limit (thực tế thường =)
                if (quoteAtLimit > quoteAtTrade) {
                    uint256 refund = quoteAtLimit - quoteAtTrade;
                    quoteBalances[pairId][buyOrder.trader] += refund;
                }

                // base: từ seller sang buyer
                require(sellOrder.lockedBase >= fill, "SELL: lockedBase underflow");
                sellOrder.lockedBase -= fill;
                baseBalances[pairId][buyOrder.trader] += fill;

                // Update tổng level
                bidLevels[pairId][priceLevel] -= fill;
            }

            // Ghi nhận trade
            _recordTrade(pairId, priceLevel, fill, maker.trader, taker.trader, takerSide);
            emit OrderPartiallyFilled(pairId, makerId, fill, maker.remaining);

            if (maker.remaining == 0) {
                maker.active = false;
                emit OrderFilled(pairId, makerId);
                _refundLocked(pairId, maker);
            }
            if (taker.remaining == 0) {
                taker.active = false;
                emit OrderFilled(pairId, takerId);
                _refundLocked(pairId, taker);
            }
        }


        // Nén queue (bỏ phần tử đầu đã xử lý)
        if (idx > 0) {
            uint256 newLen = 0;
            for (uint256 i = idx; i < q.length; i++) q[newLen++] = q[i];
            while (q.length > newLen) q.pop();
        }
    }

    function _recordTrade(
        uint256 pairId,
        uint256 price,
        uint256 amount,
        address maker,
        address taker,
        Side takerSide
    ) internal {
        // last price
        lastPrice[pairId] = price;
        lastPriceTime[pairId] = block.timestamp;

        // ring buffer
        uint256 c = recentTradeCount[pairId];
        uint256 slot = c % MAX_RECENT_TRADES;
        recentTrades[pairId][slot] = Trade({
            ts: block.timestamp,
            price: price,
            amount: amount,
            maker: maker,
            taker: taker,
            takerSide: takerSide
        });
        recentTradeCount[pairId] = c + 1;

        emit TradeExecuted(pairId, price, amount, maker, taker, takerSide);
    }

    function _refundLocked(uint256 pairId, Order storage o) internal {
        if (o.lockedBase > 0) {
            baseBalances[pairId][o.trader] += o.lockedBase;
            o.lockedBase = 0;
        }
        if (o.lockedQuote > 0) {
            quoteBalances[pairId][o.trader] += o.lockedQuote;
            o.lockedQuote = 0;
        }
    }


    /* ===== Views for frontend ===== */

    function getTopOfBook(uint256 pairId, uint256 n)
        external
        view
        returns (
            uint256[] memory bidPx,
            uint256[] memory bidSz,
            uint256[] memory askPx,
            uint256[] memory askSz
        )
    {
        require(pairs[pairId].exists, "pair not found");

        uint256[] storage bp = bidPrices[pairId];
        uint256[] storage ap = askPrices[pairId];

        uint256 bn = bp.length < n ? bp.length : n;
        uint256 an = ap.length < n ? ap.length : n;

        bidPx = new uint256[](bn);
        bidSz = new uint256[](bn);
        askPx = new uint256[](an);
        askSz = new uint256[](an);

        for (uint256 i = 0; i < bn; i++) {
            uint256 p = bp[i];
            bidPx[i] = p;
            bidSz[i] = bidLevels[pairId][p];
        }
        for (uint256 j = 0; j < an; j++) {
            uint256 p2 = ap[j];
            askPx[j] = p2;
            askSz[j] = askLevels[pairId][p2];
        }
    }

    function getRecentTrades(uint256 pairId) external view returns (Trade[] memory out) {
        require(pairs[pairId].exists, "pair not found");
        uint256 count = recentTradeCount[pairId];
        uint256 len = count < MAX_RECENT_TRADES ? count : MAX_RECENT_TRADES;
        out = new Trade[](len);
        if (len == 0) return out;

        // newest first
        for (uint256 i = 0; i < len; i++) {
            uint256 idx = (count - 1 - i) % MAX_RECENT_TRADES;
            out[i] = recentTrades[pairId][idx];
        }
    }

    function getLastPrice(uint256 pairId) external view returns (uint256 price, uint256 timestamp) {
        return (lastPrice[pairId], lastPriceTime[pairId]);
    }

    function getPairMeta(uint256 pairId)
        external
        view
        returns (string memory symbol, uint8 priceDecimals, uint8 baseDecimals, uint8 quoteDecimals)
    {
        Pair memory p = pairs[pairId];
        require(p.exists, "pair not found");
        return (p.symbol, p.priceDecimals, p.baseDecimals, p.quoteDecimals);
    }

    function getBestBidAsk(uint256 pairId)
        external
        view
        returns (bool hasBid, uint256 bidPx, uint256 bidSz, bool hasAsk, uint256 askPx, uint256 askSz)
    {
        uint256[] storage bp = bidPrices[pairId];
        uint256[] storage ap = askPrices[pairId];
        if (bp.length > 0) {
            bidPx = bp[0];
            bidSz = bidLevels[pairId][bidPx];
            hasBid = bidSz > 0;
        }
        if (ap.length > 0) {
            askPx = ap[0];
            askSz = askLevels[pairId][askPx];
            hasAsk = askSz > 0;
        }
    }

    /* ===== Vault: deposit / withdraw ===== */

    function depositBase(uint256 pairId, uint256 amount) external {
        Pair storage p = pairs[pairId];
        require(p.exists, "pair not found");
        require(amount > 0, "amount=0");

        require(p.baseToken.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        baseBalances[pairId][msg.sender] += amount;

        emit BaseDeposited(pairId, msg.sender, amount);
    }

    function depositQuote(uint256 pairId, uint256 amount) external {
        Pair storage p = pairs[pairId];
        require(p.exists, "pair not found");
        require(amount > 0, "amount=0");

        require(p.quoteToken.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        quoteBalances[pairId][msg.sender] += amount;

        emit QuoteDeposited(pairId, msg.sender, amount);
    }

    function withdrawBase(uint256 pairId, uint256 amount) external {
        Pair storage p = pairs[pairId];
        require(p.exists, "pair not found");
        require(amount > 0, "amount=0");
        require(baseBalances[pairId][msg.sender] >= amount, "insuff base");

        baseBalances[pairId][msg.sender] -= amount;
        require(p.baseToken.transfer(msg.sender, amount), "transfer failed");

        emit BaseWithdrawn(pairId, msg.sender, amount);
    }

    function withdrawQuote(uint256 pairId, uint256 amount) external {
        Pair storage p = pairs[pairId];
        require(p.exists, "pair not found");
        require(amount > 0, "amount=0");
        require(quoteBalances[pairId][msg.sender] >= amount, "insuff quote");

        quoteBalances[pairId][msg.sender] -= amount;
        require(p.quoteToken.transfer(msg.sender, amount), "transfer failed");

        emit QuoteWithdrawn(pairId, msg.sender, amount);
    }

    function _quoteAmount(uint256 price, uint256 baseAmount) internal pure returns (uint256) {
        // Giả sử price & baseAmount cùng scale 1e18 (WAD)
        // quote = price * baseAmount / 1e18
        return price.mulWad(baseAmount);
    }

    function getPairTokens(uint256 pairId)
    external
    view
    returns (address baseToken, address quoteToken)
    {
        Pair memory p = pairs[pairId];
        require(p.exists, "pair not found");
        return (address(p.baseToken), address(p.quoteToken));
    }
}
