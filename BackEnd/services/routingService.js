const { sfcsPool } = require('../DB');

// Model picker options for the Routing page's Model selector: every distinct
// (model, customer) pair in wymysfcs.sfcmodel, plus the customer list on its
// own for a narrowing filter. Small (dozens of rows) — fetched whole and
// filtered client-side rather than queried per keystroke.
async function getModelOptions() {
  const result = await sfcsPool.query(
    `select distinct model, customer
     from wymysfcs.sfcmodel
     where model is not null and model <> ''
     order by customer, model`
  );
  const models = result.rows;
  const customers = [...new Set(models.map(r => r.customer).filter(Boolean))].sort();
  return { models, customers };
}

module.exports = { getModelOptions };
