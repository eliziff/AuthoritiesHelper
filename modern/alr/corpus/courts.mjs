// What each file of A2AJ's corpus holds, by its folder name on Hugging Face.
const COURTS = {
  BCCA: "Court of Appeal for British Columbia", BCSC: "Supreme Court of British Columbia",
  CART: "Canada Agricultural Review Tribunal", CHRT: "Canadian Human Rights Tribunal",
  CIRB: "Canada Industrial Relations Board", CITT: "Canadian International Trade Tribunal",
  CMAC: "Court Martial Appeal Court of Canada", CT: "Competition Tribunal", FC: "Federal Court",
  FCA: "Federal Court of Appeal", FPSLREB: "Federal Public Sector Labour Relations and Employment Board",
  NSCA: "Nova Scotia Court of Appeal", NSFC: "Nova Scotia Family Court", NSPC: "Provincial Court of Nova Scotia",
  NSSC: "Supreme Court of Nova Scotia", NSSM: "Nova Scotia Small Claims Court",
  OHSTC: "Occupational Health and Safety Tribunal Canada", OIC: "Office of the Information Commissioner of Canada",
  ONCA: "Court of Appeal for Ontario", PSDPT: "Public Servants Disclosure Protection Tribunal",
  RAD: "Refugee Appeal Division", RLLR: "Refugee Law Lab Reporter", RPD: "Refugee Protection Division",
  SCC: "Supreme Court of Canada", SCT: "Specific Claims Tribunal", SST: "Social Security Tribunal",
  TATC: "Transportation Appeal Tribunal of Canada", TCC: "Tax Court of Canada", YKCA: "Court of Appeal of Yukon",
};
const JURISDICTIONS = {
  FED: "Federal", AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};

/** "Supreme Court of Canada", or "Federal statutes" for LEGISLATION-FED; the folder name when unknown. */
export function courtName(court) {
  const law = /^(LEGISLATION|REGULATIONS)-([A-Z]+)$/u.exec(court);
  if (law) return JURISDICTIONS[law[2]] ? `${JURISDICTIONS[law[2]]} ${law[1] === "LEGISLATION" ? "statutes" : "regulations"}` : court;
  return COURTS[court] ?? court;
}
