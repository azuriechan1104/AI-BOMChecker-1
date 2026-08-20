const { sfcsPool } = require('../DB');

// Derives a human-readable "category" per sfcupnroute row from its
// sfcmodel.description, via the same pattern rules the NPI team uses to
// group route hardware in Excel, plus "cust_name" — sfcmodel.customer with
// known aliases folded together (e.g. any "Yong*" customer, and the literal
// "Generic", both really mean "KINABALU"). String.raw keeps every
// `\d`/`\s`/`\m`/`\M` regex escape intact — a plain template literal would
// silently eat the backslashes (`"\d"` -> `"d"`), corrupting every pattern
// below.
const CATEGORIZED_ROUTES_CTE = String.raw`
  with categorized as (
    select s.modelfamily, s.upn, s2.model, s2.customer, s2.description, s.route, s.updatetime,
    CASE
        -- 1. FIXED LITERALS & SPECIAL FLAGS
        WHEN description ~* 'KIN\s+RACK.*FRU' THEN 'rack FRU'
        WHEN description ~* 'HD\s+MP'          THEN 'HD MP'
        WHEN description ~* 'YV3\.5'           THEN 'YV3.5'
        WHEN description ~* '\mDC-?SCM\M'     THEN 'DCSCM'
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
        -- 5. DYNAMIC TETON / T2PDS / T3PDS PLATFORMS
        WHEN description ~* 'TETON|T2PDS|T3PDS' THEN
            concat_ws(' ',
                substring(description FROM '(?i)L\d+'),
                COALESCE(
                    UPPER(substring(description FROM '(?i)TETON\d*')),
                    UPPER(substring(description FROM '(?i)T\d+PDS')),
                    'TETON'
                ),
                CASE
                    WHEN description ~* 'RPM' THEN 'RPM'
                    WHEN description ~* 'HEADNODE|\bHN\b' THEN 'HEADNODE'
                    WHEN description ~* 'RACK' THEN 'RACK'
                    WHEN description ~* 'JBOG' THEN 'JBOG'
                    WHEN description ~* 'SLED' THEN 'SLED'
                END
            )
        -- 6. PROJECT SPECIFIC RULES (EXO-MBX, NANAKA, BF, PENROSE)
        -- Dynamic Gen7 / G7 version check (Handles G7.1, G7.2, GEN7.4, etc.)
        WHEN description ~* 'G(?:EN)?7\.\d+'   THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE
                                                            WHEN description ~* 'RACK' THEN 'L11'
                                                            ELSE 'L10'
                                                        END
                                                    ),
                                                    INITCAP(substring(description FROM '(?i)G(?:EN)?7\.\d+'))
                                                 )
        WHEN description ~* 'EXO-MBX|MBX'     THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)\mL\d+\M'),
                                                        CASE
                                                            WHEN description ~* 'RACK' THEN 'L11'
                                                            ELSE 'L10'
                                                        END
                                                    ),
                                                    'Gen7'
                                                 )
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
        WHEN description ~* 'TETON\s*PRIME'   THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    'TETON'
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
        -- 10. GENERATION & HARDWARE FALLBACKS
        WHEN description ~* '(S2130|S2260|C2030)' THEN concat_ws(' ',
                                                    COALESCE(
                                                        substring(description FROM '(?i)L\d+'),
                                                        'L10'
                                                    ),
                                                    'Gen7'
                                                 )
        WHEN description ~* '\mG\d+(?:\.\d+)?\M' THEN concat_ws(' ',
                                                substring(description FROM '(?i)L\d+'),
                                                UPPER(substring(description FROM '(?i)\mG\d+(?:\.\d+)?\M'))
                                             )
        WHEN description ~* 'GEN\s*\d+(?:\.\d+)?' THEN concat_ws(' ',
                                                    substring(description FROM '(?i)L\d+'),
                                                    'Gen' || regexp_replace(
                                                        substring(description FROM '(?i)GEN\s*\d+(?:\.\d+)?'),
                                                        '(?i).*?(\d+(?:\.\d+)?).*',
                                                        '\1'
                                                    )
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
  )
`;

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

module.exports = { getModelOptions, getRoutingSummary, getRoutingDetail };
