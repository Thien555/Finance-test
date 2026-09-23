const Database = require('better-sqlite3');
const db = new Database('data/finance.db', { readonly: true });
const q1 = `
SELECT e.AccountingEventID, e.JournalTypeCode, e.EventSeq, e.AmountSource, e.Amount, p.Gross, p.Fee, p.Net
FROM AccountingEvent e JOIN RawPaypal p ON e.SourceID = 'PAYPAL|' || p.SourceKey
WHERE e.DataSource = 'PAYPAL'
  AND ROUND(e.Amount,2) <> ROUND(CASE e.AmountSource WHEN 'GROSS' THEN p.Gross WHEN 'FEE' THEN p.Fee WHEN 'NET' THEN p.Net END,2)
LIMIT 5`;
console.log('paypal mismatches:', db.prepare(q1).all());
const cnt = db.prepare(`SELECT DataSource, AmountSource, COUNT(*) n FROM AccountingEvent GROUP BY 1,2 ORDER BY 1,2`).all();
console.log(cnt);
