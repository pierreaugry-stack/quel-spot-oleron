"use strict";
/* Stockage des reviews (Supabase). L'adresse et la clé « anon » sont publiques par conception :
   les droits sont limités par les règles de la base (lecture seule + publication avec code). */
const REVIEW_CFG = {
  url: "",
  key: ""
};
