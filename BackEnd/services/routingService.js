const { sfcsPool } = require('../DB');

// Derives a human-readable "category" per sfcupnroute row from its
// sfcmodel.description, via the same pattern rules the NPI team uses to
// group route hardware in Excel, plus "cust_name" — sfcmodel.customer with
// known aliases folded together (e.g. any "Yong*" customer, and the literal
// "Generic", both really mean "KINABALU"). String.raw keeps every
// `\d`/`\s`/`\m`/`\M` regex escape intact — a plain template literal would
// silently eat the backslashes (`"\d"` -> `"d"`), corrupting every pattern
// below. Wrapped into a `categorized` CTE below — either scoped to the
// tracked model families or not, depending on the caller.
const CATEGORIZED_ROUTES_SELECT = String.raw`
    select s.modelfamily, s.upn, s2.model, s2.customer, s2.description, s.route, s.updatetime,
    CASE
        -- 1. FIXED LITERALS & SPECIAL FLAGS
        WHEN description ~* 'KIN\s+RACK.*FRU' THEN 'rack FRU'
        WHEN description ~* 'HD\s+MP'          THEN 'HD MP'
        WHEN description ~* 'YV3\.5'           THEN 'YV3.5'
        WHEN description ~* '\m(?:DC-?)?SCM\M' THEN 'DCSCM'
        -- 2. CABLE ASSEMBLIES
        WHEN description ~* 'EXT\s+C\.A\s+LAN' THEN 'AEC CABLE'
        -- 3. ZBOX TEST FIXTURES (Evaluated BEFORE standard TETON to catch fixture hardware)
        WHEN description ~* 'ZBOX' THEN
            concat_ws(' ',
                'ZBOX',
                COALESCE(
                    UPPER(substring(description FROM '(?i)TETON\d*')),
                    UPPER(substring(description FROM '(?i)T\d+PDS'))
                ),
                CASE
                    WHEN description ~* 'RPM' THEN 'RPM'
                    WHEN description ~* 'AEC' THEN 'AEC FIXTURE'
                END
            )
        -- 4. OSV FIXTURES
        WHEN description ~* 'OSV\s+FIXTURE'   THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    'OSV FIXTURE'
                                                 )
        -- 5. DYNAMIC T2PDS / T3PDS PLATFORMS
        WHEN description ~* 'T2PDS|T3PDS' THEN
            concat_ws(' ',
                -- 1. Level Fallback (Defaults to L11 for RACK, L10 otherwise)
                COALESCE(
                    substring(description FROM '(?i)\mL\d+\M'),
                    CASE
                        WHEN description ~* 'RACK' THEN 'L11'
                        ELSE 'L10'
                    END
                ),
                -- 2. Direct Platform Extraction (Guaranteed to match T2PDS or T3PDS)
                UPPER(substring(description FROM '(?i)\mT\d+PDS\M')),
                -- 3. Sub-type Suffix
                CASE
                    WHEN description ~* '\mRPM\M'         THEN 'RPM'
                    WHEN description ~* 'HEADNODE|\mHN\M' THEN 'HEADNODE'
                    WHEN description ~* '\mRACK\M'        THEN 'RACK'
                    WHEN description ~* '\mJBOG\M'        THEN 'JBOG'
                    WHEN description ~* '\mSLED\M'        THEN 'SLED'
                END
            )
        -- 6. PROJECT SPECIFIC RULES (EXO-MBX, NANAKA, BF, PENROSE)
        WHEN description ~* 'NANAKA.*(MOBO|HEATSINK|ASSEMBLY)' THEN 'NANAKA FRU'
        WHEN description ~* 'NANAKA'          THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE
                                                            WHEN description ~* 'RACK' THEN 'L11'
                                                            ELSE 'L10'
                                                        END
                                                    ),
                                                    'NANAKA'
                                                 )
        -- TETON Family Rule (Handles TETON / TETON2 / T2PDS / T3PDS + Sub-types)
        WHEN description ~* 'TETON|T2PDS|T3PDS' THEN
            concat_ws(' ',
                -- 1. Level Fallback
                COALESCE(
                    substring(description FROM '(?i)\mL\d+\M'),
                    CASE
                        WHEN description ~* 'RACK' THEN 'L11'
                        ELSE 'L10'
                    END
                ),
                -- 2. Platform Extraction
                CASE
                    WHEN description ~* '\mTETON2\M' THEN 'TETON2'
                    WHEN description ~* '\mT2PDS\M'  THEN 'T2PDS'
                    WHEN description ~* '\mT3PDS\M'  THEN 'T3PDS'
                    ELSE 'TETON'
                END,
                -- 3. Sub-type Suffix (Flexible matching for prefixes like JBOG_SAM)
                CASE
                    WHEN description ~* 'RPM'             THEN 'RPM'
                    WHEN description ~* 'HEADNODE|\mHN\M' THEN 'HEADNODE'
                    WHEN description ~* 'RACK'            THEN 'RACK'
                    WHEN description ~* 'JBOG'            THEN 'JBOG'
                    WHEN description ~* 'SLED'            THEN 'SLED'
                END
            )
        WHEN description ~* '\mBF(21)?\M'      THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE
                                                            WHEN description ~* 'RACK' THEN 'L11'
                                                            ELSE 'L10'
                                                        END
                                                    ),
                                                    'BF21'
                                                 )
        WHEN description ~* 'PENROSE'          THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    'PENROSE'
                                                 )
        -- 7. LOOSE / FRU PATTERNS
        WHEN description ~* '\mLOOSE\M'        THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)L\d+'),
                                                        'L10'
                                                    ),
                                                    'FRU',
                                                    CASE
                                                        WHEN description ~* '(G(EN)?\s*|-|\s)\d+(\.\d+)?(?![A-Za-z])'
                                                             AND description !~* '\d+(\.\d+)?(M|T|G|K|CM|MM)(?![A-Za-z0-9])'
                                                        THEN 'Gen' || regexp_replace(
                                                            description,
                                                            '^.*?(?:G(?:EN)?\s*|-|\s)(\d+(?:\.\d+)?)(?![A-Za-z]).*$',
                                                            '\1',
                                                            'i'
                                                        )
                                                    END
                                                 )
        -- 8. SLEDS & STORAGE COMPONENTS
        WHEN description ~* '\mKIN\M'          THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE
                                                            WHEN description ~* 'RACK' THEN 'L11'
                                                            ELSE 'L10'
                                                        END
                                                    ),
                                                    'KINABALU'
                                                 )
        WHEN description ~* 'L\d+\s+HD'        THEN substring(description FROM '(?i)L\d+\s+HD')
        WHEN description ~* 'SSD-M'            THEN concat_ws(' ',
                                                    substring(description FROM '(?i)SSD-M'),
                                                    substring(description FROM '(?i)(M\.2|E1\.S)')
                                                 )
        -- 9. NAMED PROJECTS (AMBROSE & HORNET)
        WHEN description ~* 'AMBROSE'          THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    substring(description FROM '(?i)MP'),
                                                    'AMBROSE'
                                                 )
        WHEN description ~* 'HORNET'           THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    regexp_replace(substring(description FROM '(?i)HORNET[A-Z0-9]*'), '(?i)A(\d+)', '\1')
                                                 )
        -- 10. SPECIFIC HARDWARE MODEL OVERRIDES
        WHEN description ~* '(S2130|S2260|C2030)' THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE WHEN description ~* 'RACK' THEN 'L11' ELSE 'L10' END
                                                    ),
                                                    'Gen7'
                                                 )
        WHEN description ~* 'EXO-MBX|MBX'     THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE WHEN description ~* 'RACK' THEN 'L11' ELSE 'L10' END
                                                    ),
                                                    'Gen7'
                                                 )
        -- 11. UNIFIED GENERATION EXTRACTOR — one rule in place of the old
        -- separate G<n> / GEN<n> / Gen7 branches. The leading [A-Z]* lets a
        -- generation stay glued to a prefix (MPGEN10.4), and the trailing
        -- capture ignores any suffix (GEN8.1_103, GEN9.1_MSF).
        WHEN description ~* '(?i)(?:^|[^A-Z0-9])[A-Z]*G(?:EN)?\s*\d+(?:\.\d+)?' THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE WHEN description ~* 'RACK' THEN 'L11' ELSE 'L10' END
                                                    ),
                                                    'Gen' || substring(description FROM '(?i)[A-Z]*G(?:EN)?\s*(\d+(?:\.\d+)?)')
                                                 )
        WHEN description ~* '\m\d+\.\d+\M'
             AND description !~* '\d+(?:\.\d+)?(M|T|G|K|CM|MM|H|W|PD|U)\M'
        THEN concat_ws(' ',
                COALESCE(
                    substring(description FROM '(?i)L\d+'),
                    CASE WHEN description LIKE '%$%' AND description NOT LIKE '%$Y%' THEN 'L10' END
                ),
                'Gen ' || regexp_replace(
                    description,
                    '^.*?(?:G(?:EN)?\.?\s*|-|\m)(\d+(?:\.\d+)?)(?![A-Za-z]).*$',
                    '\1',
                    'i'
                )
             )
    END AS category,
    case
        when customer ilike 'Yong%' then 'KINABALU'
        when customer ilike 'Generic' then 'KINABALU'
        else customer
    end as cust_name
    from wymysfcs.sfcupnroute s
    left join wymysfcs.sfcmodel s2 on s.upn = s2.upn
`;

// Scoped to the model families the NPI team tracks on the Routing page. Any
// other modelfamily is excluded outright, so it affects every consumer of
// CATEGORIZED_ROUTES_CTE — including the Customer selector, which only lists
// customers holding routes within these families.
const TRACKED_MODEL_FAMILIES_FILTER = `
    where s.modelfamily in (
      'BPD01U010001', 'BPD033010001', 'BPD02A010001', 'BPD04S010001',
      'BPD04E010001', 'BPD041010001', 'B10U2310',     'B10D2302',
      'B1172406',     'BPD04U010001', 'B11X2505',     'B1182407',
      'B10K2305',     'BPD04G010001', 'BPD04P100001', 'B11O2502',
      'BPD04Q010001'
    )
`;

// The Customer-driven views (selector, summary pivot, cell drill-through) all
// work off the tracked-model-family slice.
const CATEGORIZED_ROUTES_CTE = `with categorized as (${CATEGORIZED_ROUTES_SELECT}${TRACKED_MODEL_FAMILIES_FILTER})`;

// UPN lookup deliberately drops the family filter: someone searching a
// specific part number wants that part's route wherever it lives, and
// silently hiding a real sfcupnroute row because its modelfamily isn't on
// the NPI team's tracked list would read as missing data. modelfamily is a
// column in the results so out-of-scope hits stay recognizable.
const ALL_CATEGORIZED_ROUTES_CTE = `with categorized as (${CATEGORIZED_ROUTES_SELECT})`;

// Customer list for the Routing page's Customer selector: every cust_name
// with at least one sfcupnroute row (via the categorization CTE, so
// customers with no actual routing data — e.g. "TBD", "Olivia" — never
// show up), post-alias-folding (e.g. "Yong*"/"Generic" -> "KINABALU").
async function getModelOptions() {
  const result = await sfcsPool.query(
    CATEGORIZED_ROUTES_CTE + `
    select distinct cust_name
    from categorized
    where cust_name is not null and cust_name <> ''
    `
  );

  // Even after alias-folding, cust_name isn't case-normalized (e.g. both
  // "MONICA" and "Monica" appear as distinct rows), which would otherwise
  // list the same customer twice. Collapse case-insensitive dupes to one
  // entry, preferring the all-caps spelling when one exists.
  const customerVariants = new Map() // lowercase -> Set of casings seen
  for (const r of result.rows) {
    if (!r.cust_name) continue
    const key = r.cust_name.toLowerCase()
    if (!customerVariants.has(key)) customerVariants.set(key, new Set())
    customerVariants.get(key).add(r.cust_name)
  }
  const customers = [...customerVariants.values()]
    .map(variants => [...variants].find(v => v === v.toUpperCase()) || [...variants][0])
    .sort()

  return { customers };
}

// Routing summary for a Customer: a pivot of route (rows) x category
// (columns), valued by count of routes — mirrors the Excel pivot table the
// NPI team builds from this same categorization logic.
async function getRoutingSummary(customer) {
  const trimmed = (customer || '').trim();
  if (!trimmed) return { routes: [], categories: [], matrix: {}, rowTotals: {}, columnTotals: {}, grandTotal: 0 };

  const result = await sfcsPool.query(
    CATEGORIZED_ROUTES_CTE + `
    select
      coalesce(route, 'Unspecified') as route,
      coalesce(category, 'Uncategorized') as category,
      count(*)::int as cnt
    from categorized
    where upper(cust_name) = upper($1)
    group by route, category
    order by route, category
    `,
    [trimmed]
  );

  const categories = [...new Set(result.rows.map(r => r.category))].sort();

  const matrix = {};
  const rowTotals = {};
  const columnTotals = {};
  let grandTotal = 0;

  for (const category of categories) columnTotals[category] = 0;

  for (const { route, category, cnt } of result.rows) {
    if (!matrix[route]) matrix[route] = {};
    matrix[route][category] = cnt;
    rowTotals[route] = (rowTotals[route] || 0) + cnt;
    columnTotals[category] += cnt;
    grandTotal += cnt;
  }

  // Rows ordered by their Grand Total, highest first (ties broken
  // alphabetically for a stable order), rather than alphabetically.
  const routes = Object.keys(rowTotals).sort((a, b) => rowTotals[b] - rowTotals[a] || a.localeCompare(b));

  return { routes, categories, matrix, rowTotals, columnTotals, grandTotal };
}

// route and category are both computed (route can be a real NULL column;
// category is a CASE expression) rather than plain stored values, so the
// "Unspecified"/"Uncategorized" pivot buckets each need an `is null` branch
// instead of a literal string match. Returns the SQL fragment, appending
// any param it needs to `params`.
function exactOrNullFilterSql(column, value, nullSentinel, params) {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === nullSentinel.toLowerCase()) return `and ${column} is null`;
  params.push(trimmed);
  return `and ${column} = $${params.length}`;
}

// Raw detail rows behind one Routing Summary pivot cell — the underlying
// sfcupnroute/sfcmodel records for a Customer + Route + Category, shown
// when the user clicks that cell's count. Route/Category must match the
// exact pivot bucket labels ("Unspecified"/"Uncategorized" included).
async function getRoutingDetail(customer, route, category) {
  const trimmed = (customer || '').trim();
  if (!trimmed) return [];

  const params = [trimmed];
  const routeSql = exactOrNullFilterSql('route', route, 'Unspecified', params);
  const categorySql = exactOrNullFilterSql('category', category, 'Uncategorized', params);

  const result = await sfcsPool.query(
    CATEGORIZED_ROUTES_CTE + `
    select modelfamily, coalesce(category, 'Uncategorized') as category, upn, description, route, updatetime
    from categorized
    where upper(cust_name) = upper($1)
    ${routeSql}
    ${categorySql}
    order by upn
    `,
    params
  );
  return result.rows;
}

// A UPN search is a substring match, so a part number's own `%`/`_`/`\`
// characters have to be neutralized or they'd act as LIKE wildcards.
// Postgres LIKE takes backslash as its escape character by default.
function escapeLikeWildcards(value) {
  return value.replace(/[\\%_]/g, ch => '\\' + ch);
}

const UPN_SEARCH_MIN_LENGTH = 2;
const UPN_SEARCH_LIMIT = 200;

// Routing rows for a part number — the second way into this page, alongside
// the Customer pivot. Matches any UPN *containing* the search text, so a
// partial part number still finds its routes, and reports whether the result
// set was capped so the UI can say so rather than quietly showing a slice.
async function getRoutingByUpn(upn) {
  const trimmed = (upn || '').trim();
  if (trimmed.length < UPN_SEARCH_MIN_LENGTH) {
    return { rows: [], truncated: false, limit: UPN_SEARCH_LIMIT, minLength: UPN_SEARCH_MIN_LENGTH };
  }

  const result = await sfcsPool.query(
    ALL_CATEGORIZED_ROUTES_CTE + `
    select
      upn,
      coalesce(cust_name, '') as customer,
      modelfamily,
      coalesce(category, 'Uncategorized') as category,
      description,
      coalesce(route, 'Unspecified') as route,
      updatetime
    from categorized
    where upn ilike $1
    -- Exact matches first: typing a full part number shouldn't bury it under
    -- the longer UPNs that merely contain it.
    order by (upper(upn) = upper($2)) desc, upn, route
    limit $3
    `,
    [`%${escapeLikeWildcards(trimmed)}%`, trimmed, UPN_SEARCH_LIMIT + 1]
  );

  const truncated = result.rows.length > UPN_SEARCH_LIMIT;
  return {
    rows: truncated ? result.rows.slice(0, UPN_SEARCH_LIMIT) : result.rows,
    truncated,
    limit: UPN_SEARCH_LIMIT,
    minLength: UPN_SEARCH_MIN_LENGTH,
  };
}

module.exports = { getModelOptions, getRoutingSummary, getRoutingDetail, getRoutingByUpn };
