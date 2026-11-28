import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), minuteMs = 60_000
const parseArgs = argv => { const out = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const [key, inline] = argv[i].slice(2).split('=', 2); out[key] = inline ?? argv[++i] } return out }
const args = parseArgs(process.argv.slice(2))
if (!args['cutoff-datetime']) throw new Error('Usage: node scripts/scan-opening-directional-shares.js --cutoff-datetime YYYY-MM-DDTHH:mm [--symbols "NSE:AAA-EQ,..."] [--min-depth-minutes 3] [--ignore-volume-rank=true]')
const input = String(args['cutoff-datetime'])
const cutoffAt = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(input) ? input : input + '+05:30')
if (!Number.isFinite(cutoffAt)) throw new Error('Invalid --cutoff-datetime. Use IST, for example 2026-11-19T09:20')
const ist = at => new Date(at + 330 * minuteMs).toISOString()
const date = ist(cutoffAt).slice(0, 10), cutoffTime = ist(cutoffAt).slice(11, 16)
const startAt = Date.parse(date + 'T09:15:00+05:30')
if (cutoffAt <= startAt) throw new Error('Cutoff must be after 09:15 IST.')
const minimumDepthMinutes = Math.max(2, Number(args['min-depth-minutes'] ?? 3))
const ignoreVolumeRank = args['ignore-volume-rank'] === 'true'
const normalize = value => String(value).replace(/\s+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '').replace(/^TVSMOTORS$/i, 'TVSMOTOR').toUpperCase()
const depthRoot = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(depthRoot)) throw new Error('Missing depth directory: ' + depthRoot)
const requested = args.symbols ? [...new Set(String(args.symbols).split(',').map(normalize).filter(Boolean))] : null
const symbols = requested ?? fs.readdirSync(depthRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => normalize(entry.name)).sort()
// NSE Indices constituent file published 2026-10-28.
const nifty50Symbols = new Set(['ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BSE', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'ITC', 'INFY', 'INDIGO', 'JSWSTEEL', 'JIOFIN', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MAXHEALTH', 'NTPC', 'NESTLEIND', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SHRIRAMFIN', 'SBIN', 'SUNPHARMA', 'TCS', 'TATACONSUM', 'TMPV', 'TATASTEEL', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO'])
const pct = (to, from) => 100 * (to / from - 1)

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', symbol + '.jsonl')
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const raw = JSON.parse(line), at = +raw.time * 1000; return Number.isFinite(at) ? [{ at, date: ist(at).slice(0, 10), open: +raw.open, close: +raw.close, volume: +raw.volume || 0 }] : [] } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function candleFeature(rows, sessionDate, recentMinutes = 0) {
  const sessionStart = Date.parse(sessionDate + 'T09:15:00+05:30'), sessionCutoff = sessionStart + (cutoffAt - startAt)
  const windowStart = recentMinutes ? sessionCutoff - recentMinutes * minuteMs : sessionStart
  const window = rows.filter(row => row.at >= windowStart && row.at < sessionCutoff)
  if (!window.length) return null
  let ema10, ema20
  for (const row of window) { ema10 ??= row.close; ema20 ??= row.close; ema10 += 2 / 11 * (row.close - ema10); ema20 += 2 / 21 * (row.close - ema20) }
  const volume = window.reduce((sum, row) => sum + row.volume, 0)
  return { returnPct: pct(window.at(-1).close, window[0].open), emaUp: ema10 > ema20, candles: window.length, averageVolume: volume / window.length }
}

function depth(symbol) {
  const file = path.join(depthRoot, symbol, symbol + '.jsonl')
  if (!fs.existsSync(file)) return null
  const state = {}, byMinute = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt); if (!Number.isFinite(at)) continue
    if (at >= cutoffAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    const bid = +state.bid_price1, ask = +state.ask_price1
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) continue
    byMinute.set(ist(at).slice(11, 16), (bid + ask) / 2)
  }
  const midpoints = [...byMinute.values()]
  if (midpoints.length < minimumDepthMinutes) return null
  const measure = values => {
    const changes = values.slice(1).map((value, index) => value - values[index]), needed = Math.ceil(changes.length * .75)
    return {
      midpointReturnPct: pct(values.at(-1), values[0]),
      bullPersistent: changes.filter(change => change > 0).length >= needed && Math.min(...values) >= values[0],
      bearPersistent: changes.filter(change => change < 0).length >= needed && Math.max(...values) <= values[0]
    }
  }
  const recent5 = midpoints.slice(-5), recent15 = midpoints.slice(-15)
  return {
    ...measure(midpoints),
    recent5: recent5.length >= 2 ? measure(recent5) : null,
    recent15: recent15.length >= 2 ? measure(recent15) : null,
  }
}

const rows = [], nifty50Rows = [], skipped = [], volumeEligible = []
for (const [index, symbol] of symbols.entries()) {
  process.stdout.write('\r\x1b[2KScanning [' + (index + 1) + '/' + symbols.length + '] ' + symbol + '...')
  const history = candles(symbol)
  if (!history) { skipped.push({ symbol, reason: 'missing candles' }); continue }
  const candle = candleFeature(history, date)
  const priorDates = [...new Set(history.filter(row => row.date < date).map(row => row.date))].sort().slice(-10)
  const prior = priorDates.map(sessionDate => candleFeature(history, sessionDate)).filter(Boolean)
  if (!candle) { skipped.push({ symbol, reason: 'missing current candles' }); continue }
  const volumeRank = prior.length === 10 ? 1 + prior.filter(row => row.averageVolume > candle.averageVolume).length : null
  const mainEligible = ignoreVolumeRank || (prior.length === 10 && volumeRank <= 3)
  const isNifty50 = nifty50Symbols.has(symbol)
  const nifty50Eligible = isNifty50 && (ignoreVolumeRank || (prior.length === 10 && volumeRank <= 3))
  if (!mainEligible && !nifty50Eligible) skipped.push({ symbol, reason: prior.length !== 10 ? 'fewer than ten prior volume windows' : 'today volume rank above 3', volumeRank })
  if (mainEligible) volumeEligible.push({ symbol, volumeRank, averageVolume: candle.averageVolume })
  if (!mainEligible && !nifty50Eligible) continue
  const book = depth(symbol)
  if (!book) { skipped.push({ symbol, reason: 'incomplete depth' }); continue }
  const row = { symbol, candle, book, lastFiveCandle: candleFeature(history, date, 5), lastFiveBook: book.recent5, lastFifteenCandle: candleFeature(history, date, 15), lastFifteenBook: book.recent15, volumeRank }
  if (mainEligible) rows.push(row)
  if (nifty50Eligible) nifty50Rows.push(row)
}
process.stdout.write('\r\x1b[2K')
if (!rows.length) throw new Error('No volume-rank-eligible stocks have both candle data and at least ' + minimumDepthMinutes + ' observed depth minutes in this window.')

const rules = [
  ['EMA structure', row => row.candle?.emaUp === true, row => row.candle?.emaUp === false],
  ['Five-candle return', row => row.candle?.returnPct > 0, row => row.candle?.returnPct < 0],
  ['Price + midpoint', row => row.candle?.returnPct > 0 && row.book?.midpointReturnPct > 0, row => row.candle?.returnPct < 0 && row.book?.midpointReturnPct < 0],
  ['Depth midpoint return', row => row.book?.midpointReturnPct > 0, row => row.book?.midpointReturnPct < 0],
  ['Depth persistence', row => row.book?.bullPersistent === true, row => row.book?.bearPersistent === true]
]
const format = value => value.toFixed(1) + '%'
const buildTable = (sourceRows, feature = '') => {
  const count = predicate => sourceRows.filter(predicate).length
  const table = rules.map(([behaviour, bull, bear]) => {
    const candleKey = feature ? feature + 'Candle' : 'candle', bookKey = feature ? feature + 'Book' : 'book'
    const bullish = 100 * count(row => bull({ candle: row[candleKey], book: row[bookKey] })) / sourceRows.length
    const bearish = 100 * count(row => bear({ candle: row[candleKey], book: row[bookKey] })) / sourceRows.length
    return { Behaviour: behaviour, Bullish: format(bullish), Bearish: format(bearish), Difference: (bullish - bearish >= 0 ? '+' : '') + format(bullish - bearish) }
  })
  const bullSum = table.reduce((sum, row) => sum + Number.parseFloat(row.Bullish), 0), bearSum = table.reduce((sum, row) => sum + Number.parseFloat(row.Bearish), 0)
  table.push({ Behaviour: 'TOTAL (sum of differences)', Bullish: format(bullSum), Bearish: format(bearSum), Difference: (bullSum - bearSum >= 0 ? '+' : '') + format(bullSum - bearSum) })
  table.push({ Behaviour: 'AVERAGE SHARE / NET DIFFERENCE', Bullish: format(bullSum / rules.length), Bearish: format(bearSum / rules.length), Difference: (bullSum - bearSum >= 0 ? '+' : '') + format((bullSum - bearSum) / rules.length) })
  return table
}
const table = buildTable(rows)
const nifty50Table = buildTable(nifty50Rows)
const lastFiveRows = rows.filter(row => row.lastFiveCandle?.candles >= 2 && row.lastFiveBook)
const lastFiveTable = buildTable(lastFiveRows, 'lastFive')
const lastFifteenRows = rows.filter(row => row.lastFifteenCandle?.candles >= 2 && row.lastFifteenBook)
const lastFifteenTable = buildTable(lastFifteenRows, 'lastFifteen')
const eligibleStocks = rows
  .map(row => ({ stock: row.symbol, volumeRank: row.volumeRank, averageVolume: row.candle.averageVolume }))
  .sort((left, right) => (left.volumeRank ?? 0) - (right.volumeRank ?? 0) || right.averageVolume - left.averageVolume || left.stock.localeCompare(right.stock))
const nifty50Stocks = nifty50Rows
  .map(row => ({ stock: row.symbol, volumeRank: row.volumeRank, averageVolume: row.candle.averageVolume }))
  .sort((left, right) => (left.volumeRank ?? 0) - (right.volumeRank ?? 0) || right.averageVolume - left.averageVolume || left.stock.localeCompare(right.stock))
const rowsBySymbol = new Map([...rows, ...nifty50Rows].map(row => [row.symbol, row]))
const classify = (bullish, bearish) => bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL'
const signedPct = value => `${value > 0 ? '+' : ''}${value.toFixed(3)}%`
const stockTableRow = stock => {
  const row = rowsBySymbol.get(stock.stock)
  const priceReturn = row.candle.returnPct
  const midpointReturn = row.book.midpointReturnPct
  return {
    Stock: stock.stock,
    'Volume rank': stock.volumeRank ?? 'ignored',
    'Average volume': +stock.averageVolume.toFixed(1),
    'EMA structure': classify(row.candle.emaUp === true, row.candle.emaUp === false),
    'Five-candle return': `${classify(priceReturn > 0, priceReturn < 0)} (${signedPct(priceReturn)})`,
    'Price + midpoint': classify(priceReturn > 0 && midpointReturn > 0, priceReturn < 0 && midpointReturn < 0),
    'Depth midpoint return': `${classify(midpointReturn > 0, midpointReturn < 0)} (${signedPct(midpointReturn)})`,
    'Depth persistence': classify(row.book.bullPersistent === true, row.book.bearPersistent === true),
  }
}
const nifty50StocksTable = nifty50Stocks.map(stockTableRow)
const eligibleStocksTable = eligibleStocks.map(stockTableRow)
const windowSummary = (label, sourceTable) => {
  const total = sourceTable.find(row => row.Behaviour === 'TOTAL (sum of differences)')
  return { Window: label, Bullish: total.Bullish, Bearish: total.Bearish, Difference: total.Difference }
}
const behaviourTable = [
  windowSummary(`Nifty50 09:15-${cutoffTime}`, nifty50Table),
  windowSummary(`All 09:15-${cutoffTime}`, table),
  windowSummary('Last 15m', lastFifteenTable),
  windowSummary('Last 5m', lastFiveTable),
]
const report = { date, startTime: '09:15', cutoffTime, cutoffExclusive: true, analyzed: rows.length, nifty50Analyzed: nifty50Rows.length, lastFiveAnalyzed: lastFiveRows.length, lastFifteenAnalyzed: lastFifteenRows.length, requested: symbols.length, volumeEligible: volumeEligible.length, skipped: skipped.length, minimumDepthMinutes, rules: { volumeUniverse: ignoreVolumeRank ? 'Volume rank ignored; every requested stock with usable candle and depth data is analyzed.' : 'Only stocks whose current average one-minute volume from 09:15 to cutoff ranks 1, 2, or 3 against the same window in the prior ten sessions.', nifty50Universe: ignoreVolumeRank ? 'Requested NIFTY 50 constituents with usable candle and depth data; volume rank is ignored by explicit override.' : 'NIFTY 50 constituents whose current average one-minute volume ranks 1, 2, or 3 against the same window in the prior ten sessions.', depthPersistence: 'At least 75% of observed minute-to-minute midpoint changes point in the side direction, with no move through the opening midpoint against that direction.' }, eligibleStocks, table, nifty50Table, lastFiveTable, lastFifteenTable }
let suffix = 1, output
if (args.json === 'true') {
  console.log(JSON.stringify(report))
} else {
  do { output = path.join(root, 'reports', date + '-0915-to-' + cutoffTime.replace(':', '') + '-directional-shares' + (suffix === 1 ? '' : '-' + suffix) + '.json'); suffix++ } while (fs.existsSync(output))
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log('\nTop volume-ranked stocks included in analysis (Nifty50)')
  console.table(nifty50StocksTable)
  console.log('\nTop volume-ranked stocks included in analysis')
  console.table(eligibleStocksTable)
  console.log('\nBullish / bearish behaviour')
  console.table(behaviourTable)
  console.log('Analyzed ' + rows.length + '/' + symbols.length + ' volume-rank-eligible stocks; cutoff is exclusive; saved ' + output)
}
