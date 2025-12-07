import json
from pathlib import Path

import matplotlib.pyplot as plt

# 1) Đường dẫn file log (mỗi dòng JSON: {"depth":..., "gas_placeLimitBuy_market_like":"..."} )
LOG_PATH = Path("logs/depth_gas.log")

depths = []
gases = []

with LOG_PATH.open() as f:
    for line in f:
        line = line.strip()
        if not line or not line.startswith("{"):
            # bỏ qua các dòng text thường
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        if "depth" in data and "gas_placeLimitBuy_market_like" in data:
            depths.append(int(data["depth"]))
            gases.append(int(data["gas_placeLimitBuy_market_like"]))

if not depths:
    raise SystemExit("Không tìm thấy dòng JSON hợp lệ trong depth_gas.log")

# sort theo depth để vẽ đẹp
pairs = sorted(zip(depths, gases), key=lambda x: x[0])
depths, gases = zip(*pairs)

print("Data:")
for d, g in zip(depths, gases):
    print(f"N={d}, gas={g}")

# 2) Plot thường (linear-linear)
plt.figure()
plt.plot(depths, gases, marker="o")
plt.xlabel("Orderbook Depth N (Pending Orders)")
plt.ylabel("Gas used for placeLimit BUY (market-like)")
plt.title("Scalability of ChainBook order matching")
plt.grid(True)
plt.tight_layout()
plt.savefig("logs/scalability_depth.png", dpi=300)

# 3) Plot log-log (dùng cho paper để nói về exponent k)
plt.figure()
plt.loglog(depths, gases, marker="o")
plt.xlabel("Orderbook depth N (log scale)")
plt.ylabel("Gas used (log scale)")
plt.title("Scalability of ChainBook (log-log plot)")
plt.grid(True, which="both")
plt.tight_layout()
plt.savefig("logs/scalability_depth_loglog.png", dpi=300)

print("Saved figures: scalability_depth.png, scalability_depth_loglog.png")
