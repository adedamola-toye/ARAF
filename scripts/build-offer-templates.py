"""
Build WakeelBoost offer-letter DOCX templates from the bank's Murabaha offer letters.

  python3 scripts/build-offer-templates.py INDIVIDUAL.docx ENTERPRISE.docx CORPORATE.docx OUT_DIR

What it does (python-docx 1.2):
  * Replaces the sample customer values in each letter with {{placeholders}}. Each placeholder is
    written into a single run, so the server-side renderer can substitute it safely.
  * Removes the sample customer's details (names, BVN, TIN, address) completely.
  * Replaces the scanned signature image (real officers' signatures) with a text signatory block;
    letters are signed by hand, signatures are never applied automatically.
  * Scrubs document author metadata.
  * Fails if any sample value is still present anywhere in the package.

The bank's clauses, letterhead, numbering and layout are otherwise unchanged.
"""
import re
import sys
import zipfile
import copy
from docx import Document
from docx.oxml.ns import qn


def replace_span(p, old, new):
    """Replace `old` (which may span several runs) with `new`, keeping the first run's formatting."""
    runs = p.runs
    text = "".join(r.text for r in runs)
    i = text.find(old)
    if i < 0:
        raise SystemExit(f"Not found in paragraph: {old!r} :: {text!r}")
    end = i + len(old)
    pos = 0
    placed = False
    for r in runs:
        t = r.text
        s, e = pos, pos + len(t)
        pos = e
        if e <= i or s >= end:
            continue
        a, b = max(i, s) - s, min(end, e) - s
        if not placed:
            r.text = t[:a] + new + t[b:]
            placed = True
        else:
            r.text = t[:a] + t[b:]


def para(doc, contains, nth=0):
    hits = [p for p in doc.paragraphs if contains in p.text]
    if len(hits) <= nth:
        raise SystemExit(f"Paragraph not found: {contains!r}")
    return hits[nth]


def delete_paragraph(p):
    p._element.getparent().remove(p._element)


def set_text(p, new):
    runs = p.runs
    runs[0].text = new
    for r in runs[1:]:
        r.text = ""


def replace_signature_image(doc, first_title_placeholder):
    """Swap the paragraph holding the signature image for a text signatory block."""
    target = None
    for p in doc.paragraphs:
        if p._element.findall(".//" + qn("w:drawing")) or p._element.findall(".//" + qn("w:pict")):
            if "Yours faithfully" not in p.text:
                target = p
    if target is None:
        raise SystemExit("Signature image paragraph not found")
    for el in target._element.findall(".//" + qn("w:drawing")) + target._element.findall(".//" + qn("w:pict")):
        el.getparent().remove(el)
    for r in target.runs:
        r.text = ""
    base = target._element
    lines = [
        "______________________________\t\t\t______________________________",
        "{{signatory_1_name}}\t\t\t\t{{signatory_2_name}}",
        f"{first_title_placeholder}\t\t\t\t{{{{signatory_2_title}}}}",
    ]
    prev = base
    for line in lines:
        new = copy.deepcopy(base)
        for r in new.findall(qn("w:r")):
            new.remove(r)
        prev.addnext(new)
        prev = new
        from docx.text.paragraph import Paragraph
        Paragraph(new, target._parent).add_run(line)
    delete_paragraph(target)


def individual(doc):
    set_text(doc.paragraphs[0], "{{offer_date}}")
    set_text(para(doc, "JOSEPH AYOOLA"), "{{customer_name}}")
    set_text(para(doc, "24 ORE ALABA ORE,"), "{{customer_address}}")
    delete_paragraph(para(doc, "Ekiti state"))
    p = para(doc, "RE: OFFER LETTER")
    replace_span(p, "N400,000 (Four hundred thousand naira only For Financing of Building materials", "{{cost_price}} ({{cost_price_words}}) for financing of {{financed_items}}")
    replace_span(para(doc, "Facility Type"), "Murabaha", "{{facility_type}}")
    replace_span(para(doc, "JOSEPH AYOOLA(“Customer”)"), "JOSEPH AYOOLA", "{{customer_name}}")
    replace_span(para(doc, "22668745086"), "22668745086", "{{bvn}}")
    common_terms(doc, cost="N400,000 (Four hundred thousand naira only", markup="(10%)", selling="N440,000 ((Four hundred and forty thousand naira only)",
                 apr="(43%)", tenor="3months", purpose="To finance building materials", instal="Equal weekly payment of N36,666.67")
    replace_span(para(doc, "Family Credit Takaful"), "0.75%", "{{takaful_rate}}")
    replace_signature_image(doc, "{{signatory_1_title}}")
    replace_span(para(doc, "hereby accept the terms"), "JOSEPH AYOOLA", "{{customer_name}}")
    set_text(para(doc, "07 -08-2026"), "{{offer_date}}")


def enterprise(doc):
    set_text(doc.paragraphs[0], "{{offer_date}}")
    set_text(para(doc, "MUHAMMAD JAFAR"), "{{proprietor_name}}")
    replace_span(para(doc, "EMILOKAN AND SONS GLOBAL VENTURES"), "EMILOKAN AND SONS GLOBAL VENTURES", "{{business_name}}")
    set_text(para(doc, "No. 1, Baki Kasuwa"), "{{customer_address}}")
    delete_paragraph(para(doc, "Kaduna State, Nigeria."))
    replace_span(para(doc, "RE: OFFER LETTER"), "N20,000,000.00(Twenty Million naira only.) To Finance 500 Bags of Soya Beans", "{{cost_price}} ({{cost_price_words}}) to finance {{financed_items}}")
    replace_span(para(doc, "Facility Type"), "Murabaha", "{{facility_type}}")
    replace_span(para(doc, "MJ DANTURAWA NIGERIA ENTERPRISES) ("), "MUHAMMAD JAFAR (trading under the Name and Style of MJ DANTURAWA NIGERIA ENTERPRISES)", "{{proprietor_name}} (trading under the Name and Style of {{business_name}})")
    replace_span(para(doc, "22532367246"), "22532367246", "{{bvn}}")
    replace_span(para(doc, "33441125-0001"), "33441125-0001", "{{tin}}")
    common_terms(doc, cost="N20,000,000.00(Twenty Million naira only.)", markup="(15%)", selling="N23,000,000.00. (Twenty-three Million Naira Only.)",
                 apr="(54%)", tenor="6 Months", purpose="To Finance 500 Bags of Soya Beans", instal="Equal Monthly payment of N3,833,333.33")
    replace_span(para(doc, "Family Credit Takaful"), "0.75%", "{{takaful_rate}}")
    set_text(para(doc, "Keyman (Takaful)"), "........................................................................... (security to be completed by Credit)")
    replace_signature_image(doc, "{{signatory_1_title}}")
    replace_span(para(doc, "I, MUHAMMAD JAFAR"), "MUHAMMAD JAFAR (trading under the Name and Style of MJ DANTURAWA NIGERIA ENTERPRISES)", "{{proprietor_name}} (trading under the Name and Style of {{business_name}})")
    replace_span(para(doc, "8th November 2026."), "8th November 2026", "{{offer_date}}")


def corporate(doc):
    set_text(para(doc, "__ __________ 20__"), "{{offer_date}}")
    set_text(para(doc, "xxxxxxxx"), "{{company_name}},")
    set_text(para(doc, "123 ABC Street"), "{{customer_address}}")
    delete_paragraph(para(doc, "Xxxxxxx"))
    replace_span(para(doc, "RE: OFFER LETTER"), "……………………………………", "{{cost_price}} ({{cost_price_words}}) to finance {{financed_items}}")
    replace_span(para(doc, "Facility Type"), "………………………………….", "{{facility_type}}")
    replace_span(para(doc, "Limited  (“Customer”)"), "……………………………………………Limited", "{{company_name}}")
    replace_span(para(doc, "1. (Insert Name of Director)"), "1. (Insert Name of Director) BVN: ……………………", "1. {{first_director_name}} BVN: {{first_director_bvn}}")
    replace_span(para(doc, "2. (Insert Name of Director)"), "2. (Insert Name of Director) BVN: …………………...", "{{#directors_rest}}{{director_index}}. {{director_name}} BVN: {{director_bvn}}{{/directors_rest}}")
    replace_span(para(doc, "0000000000 - 0001"), "0000000000 - 0001", "{{tin}}")
    replace_span(para(doc, "Cost Price"), "N0,000,000.00 (                      Naira only)", "{{cost_price}} ({{cost_price_words}})")
    replace_span(para(doc, "Mark Up"), "(%)", "({{markup_rate_tenor}})")
    replace_span(para(doc, "Selling Price"), "N0,000,000.00 (                      Naira only)", "{{cost_plus_markup}} ({{cost_plus_markup_words}})")
    replace_span(para(doc, "Annual Percentage Rate"), "(%)", "({{apr}})")
    replace_span(para(doc, "Tenor:"), "xxxxxxxxxxxxxxxxxx", "{{tenor_months}} months")
    replace_span(para(doc, "Purpose:"), "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "To finance {{financed_items}}")
    p = para(doc, "Instalment Payment:")
    m = re.search(r"Equal Monthly payment of N[.…]+", p.text)
    replace_span(p, m.group(0), "Equal {{instalment_frequency}} payment of {{instalment_amount}}")
    replace_span(para(doc, "Family Credit Takaful"), "X%", "{{takaful_rate}}")
    replace_span(para(doc, "Stamp Duty:"), "X%", "{{stamp_duty_rate}}")
    p = para(doc, "INSERT NAME")
    replace_span(p, "INSERT NAME", "{{signatory_1_name}}")
    replace_span(p, "INSERT NAME", "{{signatory_2_name}}")
    p = para(doc, "Relationship Manager")
    replace_span(p, "Relationship Manager", "{{signatory_1_title}}")
    replace_span(p, "Business Executive", "{{signatory_2_title}}")
    p = para(doc, "on behalf of")
    text = p.text
    m = re.search(r"on behalf of\s*([.…]+\s*Ltd)", text)
    if not m:
        raise SystemExit("behalf line")
    replace_span(p, m.group(1), "{{company_name}}")


def common_terms(doc, cost, markup, selling, apr, tenor, purpose, instal):
    replace_span(para(doc, "Cost Price"), cost, "{{cost_price}} ({{cost_price_words}})")
    replace_span(para(doc, "Mark Up rate"), markup, "({{markup_rate_tenor}})")
    replace_span(para(doc, "Selling Price"), selling, "{{cost_plus_markup}} ({{cost_plus_markup_words}})")
    replace_span(para(doc, "Annual Percentage Rate"), apr, "({{apr}})")
    replace_span(para(doc, "Tenor:"), tenor, "{{tenor_months}} months")
    replace_span(para(doc, "Purpose:"), purpose, "To finance {{financed_items}}")
    replace_span(para(doc, "Instalment Payment:"), instal, "Equal {{instalment_frequency}} payment of {{instalment_amount}}")


SAMPLE_VALUES = [
    "JOSEPH", "AYOOLA", "22668745086", "ORE ALABA", "Ekiti", "MUHAMMAD", "JAFAR", "EMILOKAN", "DANTURAWA", "22532367246",
    "33441125", "Baki Kasuwa", "Kaduna", "Soya", "Fashina", "Ademowo", "Rotimi", "Abdullahi Umoru", "SODJETE",
]


def scrub_and_check(path):
    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "docProps/core.xml":
                s = data.decode()
                s = re.sub(r"<dc:creator>.*?</dc:creator>", "<dc:creator>WakeelBoost Work Desk</dc:creator>", s)
                s = re.sub(r"<cp:lastModifiedBy>.*?</cp:lastModifiedBy>", "<cp:lastModifiedBy>WakeelBoost Work Desk</cp:lastModifiedBy>", s)
                data = s.encode()
            if item.filename.endswith((".xml", ".rels")):
                s = data.decode("utf-8", "ignore")
                for v in SAMPLE_VALUES:
                    if v.lower() in s.lower():
                        raise SystemExit(f"Sample value {v!r} still present in {item.filename}")
            zout.writestr(item, data)
    import os
    os.replace(tmp, path)


def drop_orphan_media(path):
    """Remove media files that no relationship references (e.g. the removed signature image)."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        rels = "".join(z.read(n).decode("utf-8", "ignore") for n in names if n.endswith(".rels"))
        referenced = set(re.findall(r'Target="([^"]+)"', rels))
        keep = []
        for n in names:
            base = n.split("/")[-1]
            if ("media/" in n) and not any(t.endswith(base) for t in referenced):
                continue
            keep.append(n)
        tmp = path + ".tmp"
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for n in keep:
                out.writestr(z.getinfo(n), z.read(n))
    import os
    os.replace(tmp, path)


def unlink_signature_rels(doc):
    """Drop relationships to images no longer referenced from the document body."""
    body = doc.element.xml
    for rid, rel in list(doc.part.rels.items()):
        if "image" in rel.reltype and f'"{rid}"' not in body:
            del doc.part.rels[rid]


if __name__ == "__main__":
    ind, ent, cor, out = sys.argv[1:5]
    for src, fn, name in [(ind, individual, "individual"), (ent, enterprise, "enterprise"), (cor, corporate, "limited")]:
        d = Document(src)
        fn(d)
        unlink_signature_rels(d)
        dest = f"{out}/murabaha-{name}.docx"
        d.save(dest)
        drop_orphan_media(dest)
        scrub_and_check(dest)
        print("built", dest)
