import type { AssetClass, MarketDataProvider, NormalizedAsset } from '../types.js';

export abstract class BaseProvider implements MarketDataProvider {
  abstract readonly name: string;
  abstract readonly priority: number;
  abstract readonly supportedClasses: readonly AssetClass[];

  async getCryptoMarkets(symbols?: string[]): Promise<NormalizedAsset[]> {
    return [];
  }

  async getStocks(symbols?: string[]): Promise<NormalizedAsset[]> {
    return [];
  }

  async getForex(pairs?: string[]): Promise<NormalizedAsset[]> {
    return [];
  }

  async getCommodities(): Promise<NormalizedAsset[]> {
    return [];
  }

  async getAsset(symbol: string, assetClass: AssetClass): Promise<NormalizedAsset | null> {
    const list = await this.fetchByClass(assetClass);
    const upper = symbol.toUpperCase();
    return list.find(a => a.symbol.toUpperCase() === upper) ?? null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const data = await this.getCryptoMarkets(['BTC']);
      return data.length > 0;
    } catch {
      return false;
    }
  }

  protected async fetchByClass(assetClass: AssetClass): Promise<NormalizedAsset[]> {
    switch (assetClass) {
      case 'crypto': return this.getCryptoMarkets();
      case 'stocks': return this.getStocks();
      case 'forex': return this.getForex();
      case 'commodities': return this.getCommodities();
    }
  }

  protected supports(assetClass: AssetClass): boolean {
    return this.supportedClasses.includes(assetClass);
  }
}
