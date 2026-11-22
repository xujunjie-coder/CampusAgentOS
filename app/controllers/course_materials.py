"""Serve catalog PDFs inline and original course files as attachments."""
from urllib.parse import quote

from tornado.web import HTTPError

from app.controllers.base import BaseHandler
from app.services.course_materials import catalog, file_path, reference_url


class CourseMaterialHandler(BaseHandler):
    def get(self, slug, action):
        self._serve(slug, action)

    def head(self, slug, action):
        self._serve(slug, action, include_body=False)

    def _serve(self, slug, action, include_body=True):
        material = catalog().get(slug)
        external = reference_url(material) if material else ""
        if external:
            if action != "preview" or not external.endswith(".pdf"):
                raise HTTPError(404)
            self.set_header("Cache-Control", "private, no-store")
            self.render("course_material.html", slug=slug, material=material, external=external)
            return
        download = action == "download"
        path = file_path(material, download) if material else None
        if not path:
            raise HTTPError(404)
        self.set_header("Cache-Control", "private, no-store")
        if action == "preview":
            self.render("course_material.html", slug=slug, material=material, external="")
            return
        size = path.stat().st_size
        ext = path.suffix
        content_type = ("application/pdf" if ext == ".pdf" else
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        disposition = "attachment" if download else "inline"
        self.set_header("Content-Type", content_type)
        self.set_header("Content-Length", size)
        self.set_header("Content-Disposition", f'{disposition}; filename="{path.name}"; '
                        f"filename*=UTF-8''{quote(material['title'] + ext, safe='')}")
        if include_body:
            self.write(path.read_bytes())
