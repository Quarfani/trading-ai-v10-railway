import { Signal, Trade, Candle } from '../types/trading.types';
import { getSymbolSpec } from '../config/symbolConfig';
import { Logger } from '../utils/Logger';
import { calculateGrossPnlAccount, estimateEntryCosts, estimateExitCosts } from '../market/CostModel';
import { getCostProfile } from '../market/CostProfiles';

const MAX_TRADE_AGE_MS = 48 * 3_600_000;

export class PaperTrader {
  private logger = new Logger('PaperTrader');
  private balance: number;
  private initialBal: number;
  private openTrades = new Map<number, PaperTrade>();
  private closedTrades: PaperTrade[] = [];
  private trades: Trade[] = [];
  private nextTicket = 1;
  private equityCurve: Array<{time:number; equity:number}> = [];

  constructor(initialBalance=10_000) {
    this.balance=initialBalance; this.initialBal=initialBalance;
    this.equityCurve=[{time:Date.now(),equity:initialBalance}];
  }

  placeOrder(signal: Signal, volume: number, timeframe='H1'): Trade {
    const spec=getSymbolSpec(signal.symbol);
    if (!(volume>0) || ![signal.price,signal.sl,signal.tp].every(Number.isFinite)) throw new Error(`Invalid paper order ${signal.symbol}`);
    const profile=getCostProfile(signal.symbol);
    const slippage=Math.random()*spec.pip*0.3*(signal.side==='BUY'?1:-1);
    const fillPrice=signal.price+slippage;
    const entryCosts=estimateEntryCosts({price:fillPrice,volume,contractSize:spec.contractSize,quoteToAccount:1},profile);
    this.balance-=entryCosts;
    const ticket=this.nextTicket++, openedAt=Date.now();
    const pt: PaperTrade={ticket,symbol:signal.symbol,side:signal.side,volume,entry:fillPrice,sl:signal.sl,tp:signal.tp,openedAt,status:'open',source:signal.source,timeframe,realizedProfit:0};
    this.openTrades.set(ticket,pt);
    const rec: Trade={ticket,symbol:signal.symbol,side:signal.side,volume,entry:fillPrice,sl:signal.sl,tp:signal.tp,status:'open',openedAt,source:signal.source,timeframe};
    this.trades.push(rec);
    this.logger.info(`[PAPER] ${signal.side} ${signal.symbol} ${volume} @ ${fillPrice}`);
    return rec;
  }

  restoreState(openRows: Trade[], closedRows: Trade[]) {
    this.openTrades.clear(); this.closedTrades=[]; this.trades=[]; this.nextTicket=1;
    const realized=closedRows.reduce((s,t)=>s+Number(t.profit??0),0);
    const openPartialRealized=openRows.reduce((s,t)=>s+Number(t.realizedProfit??0),0);
    this.balance=this.initialBal+realized+openPartialRealized;
    for(const row of openRows){
      const spec=getSymbolSpec(row.symbol);
      this.balance-=spec.pip*spec.contractSize*row.volume*spec.spreadMaxPips*0.5;
    }
    this.equityCurve=[{time:Date.now(),equity:this.balance}];
    for(const row of closedRows.slice().reverse()){
      this.trades.push({...row});
      this.closedTrades.push({ticket:row.ticket!,symbol:row.symbol,side:row.side,volume:row.volume,entry:row.entry,sl:row.sl,tp:row.tp,openedAt:row.openedAt,closedAt:row.closedAt,status:'closed',profit:row.profit,exitReason:row.exitReason,source:row.source,timeframe:row.timeframe});
      if(row.ticket) this.nextTicket=Math.max(this.nextTicket,row.ticket+1);
    }
    this.restoreOpenTrades(openRows);
  }

  restoreOpenTrades(rows: Trade[]) {
    for(const row of rows){
      if(!row.ticket||this.openTrades.has(row.ticket)) continue;
      this.openTrades.set(row.ticket,{ticket:row.ticket,symbol:row.symbol,side:row.side,volume:row.volume,entry:row.entry,sl:row.sl,tp:row.tp,openedAt:row.openedAt,status:'open',source:row.source,timeframe:row.timeframe,realizedProfit:Number(row.realizedProfit??0)});
      this.trades.push({...row});
      this.nextTicket=Math.max(this.nextTicket,row.ticket+1);
    }
  }

  modifyTrade(ticket:number,newSl:number,newTp:number){
    const t=this.openTrades.get(ticket); if(!t) return false;
    t.sl=newSl; t.tp=newTp;
    const rec=this.trades.find(x=>x.ticket===ticket&&x.status==='open'); if(rec){rec.sl=newSl;rec.tp=newTp;}
    return true;
  }

  partialClose(ticket:number,volume:number,exitPrice:number,reason='PARTIAL'): {ok:boolean;profit:number;remainingVolume:number}{
    const t=this.openTrades.get(ticket); if(!t || !(volume>0) || volume>=t.volume) return {ok:false,profit:0,remainingVolume:t?.volume??0};
    const spec=getSymbolSpec(t.symbol);
    const closedVolume=Math.min(volume,t.volume);
    const profile=getCostProfile(t.symbol);
    const raw=calculateGrossPnlAccount({entryPrice:t.entry,exitPrice,volume:closedVolume,contractSize:spec.contractSize,quoteToAccount:1,side:t.side});
    const exitCosts=estimateExitCosts({price:exitPrice,volume:closedVolume,contractSize:spec.contractSize,quoteToAccount:1},profile);
    const profit=raw-exitCosts;
    t.volume=+(t.volume-closedVolume).toFixed(8);
    t.realizedProfit=(t.realizedProfit??0)+profit;
    this.balance+=profit;
    const rec=this.trades.find(x=>x.ticket===ticket&&x.status==='open');
    if(rec){rec.volume=t.volume;rec.realizedProfit=t.realizedProfit;rec.commission=(rec.commission??0)+0;}
    this.equityCurve.push({time:Date.now(),equity:this.balance});
    this.logger.info(`[PAPER] Partial close ${t.symbol} ${closedVolume} @ ${exitPrice} profit=${profit.toFixed(2)} remaining=${t.volume}`);
    return {ok:true,profit,remainingVolume:t.volume};
  }

  closeTrade(ticket:number,exitPrice:number,reason:'TP'|'SL'|'TIMEOUT'|'MANUAL'='MANUAL',at=Date.now()):{ok:boolean;profit:number}{
    const t=this.openTrades.get(ticket); if(!t) return {ok:false,profit:0};
    const spec=getSymbolSpec(t.symbol); let fill=exitPrice;
    if(reason==='SL'){const slip=Math.random()*0.5;fill+=t.side==='BUY'?-slip*spec.pip:slip*spec.pip;}
    const holdingDays=Math.max(0,(at-t.openedAt)/(24*3_600_000));
    const raw=calculateGrossPnlAccount({entryPrice:t.entry,exitPrice:fill,volume:t.volume,contractSize:spec.contractSize,quoteToAccount:1,side:t.side});
    const profile=getCostProfile(t.symbol);
    const exitCosts=estimateExitCosts({price:fill,volume:t.volume,contractSize:spec.contractSize,quoteToAccount:1},profile);
    const finalProfit=raw-exitCosts;
    const profit=(t.realizedProfit??0)+finalProfit;
    this.balance+=finalProfit; t.status='closed';t.closedAt=at;t.profit=profit;t.exitReason=reason;
    this.openTrades.delete(ticket);this.closedTrades.push(t);
    const rec=this.trades.find(x=>x.ticket===ticket&&x.status==='open');
    if(rec){rec.status='closed';rec.closedAt=at;rec.profit=profit;rec.exitReason=reason;rec.volume=t.volume;rec.realizedProfit=t.realizedProfit??0;}
    this.equityCurve.push({time:at,equity:this.balance});
    return {ok:true,profit};
  }

  updateTrades(candle:Candle){
    for(const t of Array.from(this.openTrades.values())){
      const hitSL=t.side==='BUY'?candle.low<=t.sl:candle.high>=t.sl;
      const hitTP=t.side==='BUY'?candle.high>=t.tp:candle.low<=t.tp;
      const timeout=Date.now()-t.openedAt>MAX_TRADE_AGE_MS;
      if(!hitSL&&!hitTP&&!timeout) continue;
      const reason=hitSL?'SL':hitTP?'TP':'TIMEOUT';
      const price=reason==='SL'?t.sl:reason==='TP'?t.tp:candle.close;
      this.closeTrade(t.ticket,price,reason,candle.time);
    }
  }

  getBalance(){return this.balance;}
  getOpenTrades(){return Array.from(this.openTrades.values());}
  getAllTrades(){return this.trades.map(t=>({...t}));}
  getEquityCurve(){return [...this.equityCurve];}
  getStats(){
    const c=this.closedTrades,w=c.filter(t=>(t.profit??0)>0),l=c.filter(t=>(t.profit??0)<=0);
    const gw=w.reduce((s,t)=>s+(t.profit??0),0),gl=Math.abs(l.reduce((s,t)=>s+(t.profit??0),0));
    const aw=w.length?gw/w.length:0,al=l.length?gl/l.length:0,pnl=this.balance-this.initialBal;
    let peak=this.initialBal,maxDD=0; for(const p of this.equityCurve){peak=Math.max(peak,p.equity);maxDD=Math.max(maxDD,peak?((peak-p.equity)/peak*100):0);}
    return {trades:c.length,wins:w.length,losses:l.length,winRate:c.length?w.length/c.length:0,profitFactor:gl?gw/gl:(gw?Infinity:0),avgWin:aw,avgLoss:al,riskReward:al?aw/al:0,totalPnl:pnl,roi:this.initialBal?pnl/this.initialBal*100:0,maxDrawdownPct:maxDD,balance:this.balance,equityCurve:this.getEquityCurve()};
  }
  reset(newBalance=10_000){this.balance=newBalance;this.initialBal=newBalance;this.openTrades.clear();this.closedTrades=[];this.trades=[];this.nextTicket=1;this.equityCurve=[{time:Date.now(),equity:newBalance}];}
}
interface PaperTrade{ticket:number;symbol:string;side:'BUY'|'SELL';volume:number;entry:number;sl:number;tp:number;openedAt:number;closedAt?:number;status:'open'|'closed';profit?:number;realizedProfit?:number;exitReason?:string;source?:string;timeframe?:string}
