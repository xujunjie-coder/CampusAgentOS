"""Index authorized PDF/DOCX attachments and preserve their original downloads."""
import argparse
import asyncio
from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.db import get_connection
from app.services.course_materials import CATALOG, ROOT, SLUG, catalog, reference_url
from app.services.intelligence_service import (
    document_vectors, embedding_engine, fingerprint, lexical_vector, split_markdown_chunks,
)


JAVA_FILES = [
    ("open-book-exam-quick-reference", "Java Web 期末开卷知识点清单", True),
    ("chapters-01-12-predicted-questions", "Java Web 1–12 章大题预测与答题模板", True),
    ("chapters-01-12-exercise-answers", "Java Web 前 12 章课后习题答案", True),
    ("course-knowledge-checklist", "Java Web 全课程知识点清单", False),
    ("beginner-course-guide", "Java Web 全课程零基础学习讲义", False),
]


def javaweb_manifest():
    return [{"slug": f"javaweb-{stem}", "path": f"javaweb/{stem}.pdf", "title": title,
             "aliases": ["javaweb"], "scope_title": "SCSWiki · 课程资料", "exam": exam,
             "credit": "SCSWiki 贡献者", "license": "CC BY-SA 4.0",
             "source_url": "https://scswiki.com/materials/javaweb"}
            for stem, title, exam in JAVA_FILES]


def read_markdown(path, title, args, temp):
    if path.suffix.lower() == ".pdf":
        text = subprocess.check_output([args.pdftotext, "-enc", "UTF-8", str(path), "-"], timeout=60)
        pages = text.decode("utf-8-sig").split("\f")
        sections = []
        for n, page in enumerate(pages, 1):
            page = page.strip()
            if page:
                sections.append(f"## 第 {n} 页\n\n" + page)
        return "# " + title + "\n\n" + "\n\n".join(sections), path

    from docx import Document
    from docx.table import Table
    document = Document(path)
    blocks = ["# " + title]
    for item in document.iter_inner_content():
        if isinstance(item, Table):
            values = [[cell.text.strip().replace("\n", " ").replace("|", "\\|") for cell in row.cells]
                      for row in item.rows]
            if values:
                values.insert(1, ["---"] * len(values[0]))
                blocks.append("\n".join("| " + " | ".join(row) + " |" for row in values))
            continue
        text = item.text.strip()
        if text:
            level = re.fullmatch(r"Heading ([1-6])", item.style.name if item.style else "")
            blocks.append(("#" * min(6, int(level[1]) + 1) + " " if level else "") + text)
    if not args.soffice:
        raise ValueError("Use --soffice to make a PDF preview for DOCX materials")
    subprocess.run([args.soffice, f"-env:UserInstallation={(temp / 'profile').as_uri()}", "--headless",
                    "--convert-to", "pdf", "--outdir", str(temp), str(path)], check=True, timeout=90)
    preview = temp / (path.stem + ".pdf")
    return "\n\n".join(blocks), preview


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Root of approved course files")
    parser.add_argument("--manifest", type=Path, help="JSON entries using the same fields as the Java Web catalog")
    parser.add_argument("--pdftotext", default="pdftotext")
    parser.add_argument("--soffice", help="LibreOffice CLI for DOCX preview conversion")
    args = parser.parse_args()
    source = args.source.resolve()
    entries = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else javaweb_manifest()
    model = embedding_engine()
    prepared = []
    references = []
    with TemporaryDirectory(prefix="course-materials-") as tmp:
        for entry in entries:
            path = (source / entry["path"]).resolve()
            slug = entry["slug"]
            if not SLUG.fullmatch(slug) or not path.is_relative_to(source):
                raise ValueError(f"Invalid material entry: {slug}")
            if not all(entry[k] for k in ("title", "aliases", "credit", "license", "scope_title")):
                raise ValueError(f"Incomplete material entry: {slug}")
            url = urlsplit(entry.get("source_url", ""))
            if url.geturl() and (url.scheme != "https" or not url.hostname):
                raise ValueError(f"Invalid source URL: {slug}")
            if "external_url" in entry:
                if not reference_url(entry):
                    raise ValueError(f"Invalid upstream attachment: {slug}")
                references.append(entry)
                continue
            if path.suffix.lower() not in {".pdf", ".docx"}:
                raise ValueError(f"Unsupported material format: {slug}")
            if path.stat().st_size > 15 * 1024 * 1024:
                raise ValueError(f"File exceeds 15 MB: {slug}")
            work = Path(tmp) / slug
            work.mkdir()
            md, preview = read_markdown(path, entry["title"], args, work)
            original, pdf = path.read_bytes(), preview.read_bytes()
            if not pdf.startswith(b"%PDF-") or len(pdf) > 15 * 1024 * 1024:
                raise ValueError(f"Invalid PDF preview: {slug}")
            meta = f"来源：{entry.get('source_url', '')}\n署名：{entry['credit']}；许可：{entry['license']}"
            chunks = [chunk + "\n\n" + meta for chunk in split_markdown_chunks(md)] if "\n\n" in md else []
            vectors = (asyncio.run(document_vectors(model, chunks)) if model and chunks
                       else [lexical_vector(chunk) for chunk in chunks])
            if len(vectors) != len(chunks):
                raise ValueError(f"Wrong vector count: {slug}")
            prepared.append((entry, path.suffix.lower(), original, pdf, md + "\n\n" + meta, chunks, vectors))

    ROOT.mkdir(parents=True, exist_ok=True)
    materials = catalog()
    with closing(get_connection()) as conn, conn:
        for entry in references:
            scope = conn.execute("SELECT id FROM knowledge_documents WHERE title=?", (entry["scope_title"],)).fetchone()
            if not scope:
                raise ValueError(f"Unknown knowledge scope: {entry['scope_title']}")
            # Keep any previously reviewed and locally hosted entry for the same file.
            slug = entry["slug"]
            if slug in materials and materials[slug].get("original"):
                continue
            materials[slug] = {k: entry[k] for k in ("title", "aliases", "credit", "license", "external_url", "source_url", "exam")}
            materials[slug]["scope_id"] = scope["id"]
        for entry, ext, original, pdf, md, chunks, vectors in prepared:
            slug = entry["slug"]
            scope = conn.execute("SELECT id FROM knowledge_documents WHERE title=?", (entry["scope_title"],)).fetchone()
            if not scope:
                raise ValueError(f"Unknown knowledge scope: {entry['scope_title']}")
            title = "课程附件 · " + entry["title"]
            doc = conn.execute("SELECT id FROM knowledge_documents WHERE title=?", (title,)).fetchone()
            if doc:
                doc_id = doc["id"]
                conn.execute("UPDATE knowledge_documents SET model=? WHERE id=?", (fingerprint(model), doc_id))
                conn.execute("DELETE FROM knowledge_chunks WHERE document_id=?", (doc_id,))
            else:
                doc_id = conn.execute("INSERT INTO knowledge_documents (title,model) VALUES (?,?)",
                                      (title, fingerprint(model))).lastrowid
            conn.executemany("INSERT INTO knowledge_chunks (document_id,content,vector) VALUES (?,?,?)",
                             [(doc_id, chunk, json.dumps(vector)) for chunk, vector in zip(chunks, vectors)])
            original_name = f"{slug}-{sha256(original).hexdigest()[:12]}{ext}"
            preview_name = f"{slug}-{sha256(pdf).hexdigest()[:12]}.pdf"
            (ROOT / original_name).write_bytes(original)
            if preview_name != original_name:
                (ROOT / preview_name).write_bytes(pdf)
            (ROOT / (slug + ".md")).write_text(md, encoding="utf-8")
            materials[slug] = {k: entry[k] for k in ("title", "aliases", "credit", "license")}
            materials[slug].update(original=original_name, preview=preview_name, scope_id=scope["id"],
                                   knowledge_id=doc_id, exam=entry.get("exam", False),
                                   source_url=entry.get("source_url", ""))
            print(f"{slug}: {len(chunks)} searchable chunks")
    pending = ROOT / (CATALOG + ".tmp")
    pending.write_text(json.dumps(materials, ensure_ascii=False, indent=2), encoding="utf-8")
    pending.replace(ROOT / CATALOG)
    print(f"Catalog updated: {len(prepared)} indexed attachments, {len(references)} original-file references")


if __name__ == "__main__":
    main()
