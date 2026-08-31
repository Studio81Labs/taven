-- Keep the quote-shipment price scope introduction separate from its first use.
-- PostgreSQL requires a newly added enum label to commit before later migrations
-- can use it in constraints and functions.
ALTER TYPE "price_component_scope" ADD VALUE 'QUOTE_SHIPMENT_PLAN';
