-- ============================================================
-- PILNĪGA SISTĒMAS PĀRBŪVE — IZDZĒŠ VISU un izveido jauno pamatu.
-- BRĪDINĀJUMS: šis fails NEATGRIEZENISKI dzēš VISUS datus visās tabulās.
-- Palaidiet šo TIKAI VIENU REIZI Neon.tech SQL Editorā.
-- ============================================================

DROP TABLE IF EXISTS
  ticket_status_history, ticket_attachments, ticket_comments, tickets,
  application_assignments, application_licenses, applications,
  asset_assignments, asset_lifecycle_events, assets, asset_categories_tree,
  phone_number_assignments, phone_numbers,
  access_rights, access_systems,
  custom_field_definitions, entity_history,
  subcategories, categories, asset_categories,
  push_tokens, sla_policies, organizations, users
  CASCADE;

-- (Jaunā shēma tiek izveidota failā schema.sql -- palaidiet to UZREIZ pēc šī.)
