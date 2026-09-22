// Run only on hosted CI. Original production files are inputs, never edited.
import ts from '../../services/shuttle-v2/node_modules/typescript/lib/typescript.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const path = root + 'services/shuttle-v2/web/src/TransitMap.tsx';
const source = readFileSync(path, 'utf8');
const hash = s => createHash('sha256').update(s).digest('hex');
if (hash(source) !== '8e89152f7af5589c0451b343ab3b85f1210eb3013df2cad537cc8d4a5d3432be') throw Error('Unsupported TransitMap source');
const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const manifest = { sourceSha256: hash(source), ranges: [] };
const all = [];
function visit(n) { all.push(n); ts.forEachChild(n, visit); }
visit(sf);
const one = (nodes, what) => { if (nodes.length !== 1) throw Error(`${what}: expected one, found ${nodes.length}`); return nodes[0]; };
const text = n => source.slice(n.getStart(sf), n.end);
function take(n, selector) {
  const s = text(n); manifest.ranges.push({ selector, start: n.getStart(sf), end: n.end, sha256: hash(s) }); return s;
}
const decl = name => one(all.filter(n => ts.isVariableDeclaration(n) && text(n.name) === name), name);
const trip = decl('TripPlanner').initializer;
const statements = [...trip.body.statements];
const names = n => ts.isVariableStatement(n) ? n.declarationList.declarations.flatMap(d =>
  ts.isIdentifier(d.name) ? [d.name.text] : [...d.name.elements].filter(ts.isBindingElement).map(e => text(e.name))) : [];
const named = name => one(statements.filter(n => names(n).includes(name)), `statement:${name}`);
const effect = dependency => one(statements.filter(n => ts.isExpressionStatement(n)
  && ts.isCallExpression(n.expression) && text(n.expression.expression) === 'useEffect'
  && text(n.expression.arguments.at(-1)) === dependency), `effect:${dependency}`);
const selected = new Set();
const add = n => selected.add(n);
[
  'initialDraft', 'fromText', 'toText', 'fromLL', 'toLL', 'reminder', 'reminderBanner', 'reminderFiredRef',
  'showAllOptions', 'tripTime', 'tripTimeSetAt', 'targetDate', 'tripTimeError', 'effectiveFromLL',
  'refreshKey', 'refreshed', 'stableOptions', 'busRoster', 'prevRosterRef', 'etaFresh', 'options',
  'optionsRef', 'reminderContextRef', 'displayOrderRef', 'orderDestRef', 'orderedOptions',
  'thirdShownRef', 'thirdDestRef', 'visibleOptions',
].forEach(n => add(named(n)));
['[stableOptions]', '[busRoster, stableOptions]', '[reminder]'].forEach(d => add(effect(d)));
for (const variable of ['optionsRef', 'reminderContextRef']) {
  add(one(statements.filter(n => ts.isExpressionStatement(n) && text(n).startsWith(`${variable}.current =`)), `assignment:${variable}`));
}
const adapterBody = statements.filter(n => selected.has(n)).map(n => take(n, `adapter:${names(n).join(',') || text(n).slice(0, 70)}`)).join('\n');
const finalReturn = one(statements.filter(ts.isReturnStatement), 'TripPlanner final return');
const referenceBody = statements.filter(n => n !== finalReturn).map(n => take(n, `reference:${n.getStart(sf)}`)).join('\n');
const leaveInput = decl('leaveInput');
const reminderActive = decl('reminderActive');
const button = one(all.filter(n => ts.isJsxElement(n) && text(n.openingElement.tagName) === 'button'
  && n.openingElement.attributes.properties.some(a => ts.isJsxAttribute(a) && text(a.name) === 'aria-pressed' && text(a.initializer) === '{reminderActive}')), 'reminder button');
const onClick = one(button.openingElement.attributes.properties.filter(a => ts.isJsxAttribute(a) && text(a.name) === 'onClick'), 'reminder click');
const armHandler = take(onClick.initializer.expression, 'reminder:original-onClick');
if (!ts.isBinaryExpression(button.parent)) throw Error('Unexpected reminder button guard');
const armCondition = take(button.parent.left, 'reminder:original-button-condition');
const probe = `
  const __arm = (routeLabel: string) => {
    const o = options?.find(x => x.routeLabel === routeLabel);
    if (!o) return false;
    const ${take(leaveInput, 'reminder:leaveInput')};
    const ${take(reminderActive, 'reminder:reminderActive')};
    if (!(${armCondition})) return false;
    (${armHandler})({stopPropagation() {}});
    return true;
  };
  __research.observe(() => ({stableOptions, options, orderedOptions, visibleOptions,
    busRoster, refreshKey, etaFresh, reminder, fired: reminderFiredRef.current,
    rank: displayOrderRef.current, orderDest: orderDestRef.current,
    third: thirdShownRef.current, thirdDest: thirdDestRef.current,
    desiredOrder: options ? preferredTripOrder(options, displayOrderRef.current?.order ?? []).map(o => o.routeLabel) : null,
    userLatLon, fromLL, toLL, showAllOptions}), {arm: __arm});
  return null;
`;
const props = text(trip.parameters[0].name).replace(/}$/, ', __research }');
// Exact source block after successful response validation, up to catch.
const applied = one(all.filter(n => ts.isTryStatement(n) && n.tryBlock.statements.some(s => text(s).includes('const liveBuses = ((data.buses'))), 'parent poll try');
const pollStatements = [...applied.tryBlock.statements];
const begin = pollStatements.findIndex(n => text(n).startsWith('setLastBusUpdateAt('));
if (begin < 0) throw Error('Missing poll application start');
const pollBody = pollStatements.slice(begin).map(n => take(n, `poll:${n.getStart(sf)}`)).join('\n');
const setters = [...new Set([...pollBody.matchAll(/\b(set[A-Z]\w*)\(/g)].map(m => m[1]))];
const poll = `export function applyPublicResponse(data: any, setters: any) {
  if (!data || !Array.isArray(data.buses)) throw new Error('Invalid bus update');
  const {${setters.join(',')}} = setters;
  ${pollBody}
}`;
// Parent wall-second effect, unchanged, with only its setTick state supplied.
const parent = decl('TransitMap').initializer;
const wall = one([...parent.body.statements].filter(n => ts.isExpressionStatement(n) && text(n).includes('1000 - (Date.now() % 1000)')), 'parent wall timer');
const wallComponent = `export function WallClock({children}: any) { const [tick,setTick] = useState(0); ${take(wall,'parent:wall-second-effect')} return children(tick); }`;
// Include imports and module constants referenced by either component body.
const snippets = `${referenceBody}\n${adapterBody}\n${probe}\n${poll}\n${wallComponent}`;
function ids(s) { const set = new Set(); const f=ts.createSourceFile('s.tsx',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX); const walk=n=>{if(ts.isIdentifier(n))set.add(n.text);ts.forEachChild(n,walk)};walk(f);return set; }
const used = ids(snippets);
const globals = [];
let changed = true;
while (changed) {
  changed = false;
  for (const node of sf.statements) {
    if (!ts.isVariableStatement(node) || names(node).includes('TripPlanner') || names(node).includes('TransitMap') || globals.includes(node)) continue;
    if (names(node).some(n => used.has(n))) { globals.push(node); for (const n of ids(text(node))) used.add(n); changed = true; }
  }
}
const boundary = new Set(['noteShown','loadTripDraft','saveTripDraft','deliverPing','ensureNotifyPermission','vibrateAlert','notifyPermissionState']);
const imports = [];
for (const node of sf.statements.filter(ts.isImportDeclaration)) {
  const c = node.importClause; if (!c) continue;
  const from = text(node.moduleSpecifier);
  const parts = [];
  if (c.name && used.has(c.name.text)) parts.push(text(c.name));
  if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
    const kept = c.namedBindings.elements.filter(e => used.has(e.name.text) && !boundary.has(e.name.text));
    if (kept.length) parts.push(`{${kept.map(text).join(',')}}`);
  }
  if (parts.length) imports.push(`import ${c.isTypeOnly ? 'type ' : ''}${parts.join(',')} from ${from};`);
}
imports.push(`import {preferredTripOrder} from './tripRanking';`);
imports.push(`import {${[...boundary].join(',')}} from '../../../../research/synthetic-selection/boundary';`);
const generated = `${imports.join('\n')}\n${globals.map(n=>take(n,'global:'+names(n).join(','))).join('\n')}
export const ReferenceTripPlanner = (${props}: any) => { ${referenceBody}\n${probe} };
export const SelectionAdapter = (${props}: any) => { const rainRef = useRef({likely:false}); ${adapterBody}\n${probe} };
${poll}\n${wallComponent}\n`;
const output = root+'services/shuttle-v2/web/src/__researchSelection.generated.tsx';
writeFileSync(output, generated);
manifest.generatedSha256 = hash(generated);
mkdirSync(root+'research/synthetic-selection/results',{recursive:true});
writeFileSync(root+'research/synthetic-selection/results/extraction.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({sourceSha256: manifest.sourceSha256, generatedSha256: manifest.generatedSha256, ranges:manifest.ranges.length}));
