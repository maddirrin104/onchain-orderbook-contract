export const PRICE_DEC = 8;
export const QUOTE_DEC = 8;

export const BASE_DEC: Record<string, number> = {
  ETH:18, WSTETH:18, LINK:18, SNX:18, GHO:18, USDG:18, USDE:18, USDL:18, DAI:18, USDC:6, PYUSD:6, FORTH:18,
  AUD:8, GBP:8, EUR:8, CZK:8, JPY:8, XAU:8, CSPX:8, IB01:8, IBTA:8, SUSDE:18,
};

export const baseOf = (symbolPair: string) =>
  symbolPair.split("-")[0].trim().toUpperCase();
