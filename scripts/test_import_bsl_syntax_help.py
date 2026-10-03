"""Source-independent tests and a bundled-resource integrity check for the importer."""

from __future__ import annotations

import io
import re
import sqlite3
import unittest
import zipfile
from pathlib import Path

from scripts import import_bsl_syntax_help as importer


def make_zip(entries: dict[str, bytes]) -> zipfile.ZipFile:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    stream.seek(0)
    return zipfile.ZipFile(stream, "r")


class ArticleExtractionTests(unittest.TestCase):
    def test_leaf_heading_wins_and_article_sections_remain_readable(self) -> None:
        source = """<html><head><title>Document fallback</title></head><body>
          <h1 class="V8SH_pagetitle">Parent.Action (Parent.Action)</h1>
          <p class="V8SH_title">Parent (Parent)</p>
          <p class="V8SH_heading">Action (Action)</p>
          <p class="V8SH_chapter">Синтаксис:</p><pre>Action(&lt;Value&gt;)</pre>
          <p class="V8SH_chapter">Возвращаемое значение:</p><p>Тип: String.</p>
          <p class="V8SH_chapter">Описание:</p><div>Returns the supplied value.</div>
        </body></html>""".encode("utf-8")

        article = importer.parse_article("Parent/Action.html", source)

        self.assertEqual(article.title, "Action (Action)")
        self.assertIn("Синтаксис:", article.content)
        self.assertIn("Action(<Value>)", article.content)
        self.assertIn("Синтаксис:\n\nAction(<Value>)", article.content)
        self.assertIn("Возвращаемое значение:", article.content)
        self.assertIn("Тип: String.", article.content)
        self.assertIn("Описание:", article.content)
        self.assertIn("Returns the supplied value.", article.content)

    def test_title_falls_back_to_page_title_then_html_title(self) -> None:
        page_title = importer.parse_article(
            "Page.html",
            b'<html><body><h1 class="V8SH_pagetitle">Page heading</h1></body></html>',
        )
        html_title = importer.parse_article("Fallback.html", b"<html><head><title>Fallback</title></head><body>Body</body></html>")

        self.assertEqual(page_title.title, "Page heading")
        self.assertEqual(html_title.title, "Fallback")


class ImportBehaviorTests(unittest.TestCase):
    def test_import_preserves_resolved_article_links_in_order_without_enabling_external_targets(self) -> None:
        archive = make_zip({
            "objects/catalog.html": b'''<body><p>Before <a href="methods/first.html">Same label</a>, then
              <a href="methods/second.html">Same label</a>. External <a href="https://example.test/x">outside</a>.
              Unsafe <a href="javascript:alert(1)">run</a>.</p></body>''',
            "objects/methods/first.html": b'''<body><h1 class="V8SH_pagetitle">First method</h1>
              <p>See <a href="second.html">peer</a>.</p></body>''',
            "objects/methods/second.html": b'<body><h1 class="V8SH_pagetitle">Second method</h1><p>Target.</p></body>',
        })
        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, content TEXT)")
        base_rows = [(1, None, "Catalog", "catalog.html", "unchanged search content")]
        connection.executemany("INSERT INTO nodes VALUES (?, ?, ?, ?, ?)", base_rows)
        connection.commit()

        importer.append_articles(connection, base_rows, archive, enforce_pinned_counts=False)

        self.assertEqual(connection.execute("SELECT id, parent_id, name, path, content FROM nodes ORDER BY id").fetchall()[:1], base_rows)
        markdown = connection.execute("SELECT markdown FROM article_markdown WHERE node_id = 1").fetchone()[0]
        self.assertIn("Before [Same label](bsl-help:syntax:2), then", markdown)
        self.assertIn("[Same label](bsl-help:syntax:3)", markdown)
        self.assertLess(markdown.index("bsl-help:syntax:2"), markdown.index("bsl-help:syntax:3"))
        self.assertIn("External outside.", markdown)
        self.assertIn("Unsafe run.", markdown)
        self.assertNotIn("https://example.test", markdown)
        self.assertNotIn("javascript:", markdown)

        method_markdown = connection.execute("SELECT markdown FROM article_markdown WHERE node_id = 2").fetchone()[0]
        self.assertIn("[peer](bsl-help:syntax:3)", method_markdown)
        archive.close()
        connection.close()

    def test_first_existing_reference_is_parent_and_unreferenced_page_is_root(self) -> None:
        archive = make_zip({
            "objects/root.html": b'<body><a href="articles/leaf.html">Leaf</a></body>',
            "objects/second.html": b'<body><a href="articles/leaf.html">Leaf</a></body>',
            "objects/articles/leaf.html": b'<body><h1 class="V8SH_pagetitle">Leaf page</h1><p>Content.</p></body>',
            "objects/orphan.html": b'<body><h1 class="V8SH_pagetitle">Orphan</h1><p>Content.</p></body>',
            "tables/ignored.html": b"<body>Not an object article</body>",
            "objects/articles/leaf.st": b"not html",
        })
        connection = sqlite3.connect(":memory:")
        connection.execute("CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, content TEXT)")
        base_rows = [
            (1, None, "Root", "root.html", "unchanged root"),
            (2, None, "Second", "second.html", "unchanged second"),
        ]
        connection.executemany("INSERT INTO nodes VALUES (?, ?, ?, ?, ?)", base_rows)
        connection.commit()

        added, linked, orphans = importer.append_articles(
            connection, base_rows, archive, enforce_pinned_counts=False,
        )

        rows = connection.execute("SELECT id, parent_id, name, path, content FROM nodes ORDER BY id").fetchall()
        self.assertEqual((added, linked, orphans), (2, 1, 1))
        self.assertEqual(rows[:2], base_rows)
        self.assertEqual(rows[2][1:4], (1, "Leaf page", "articles/leaf.html"))
        self.assertEqual(rows[3][1:4], (None, "Orphan", "orphan.html"))
        self.assertIn("Content.", rows[2][4])
        self.assertIn("Content.", rows[3][4])

        second_run, second_linked, second_orphans = importer.append_articles(
            connection, rows, archive, enforce_pinned_counts=False,
        )
        self.assertEqual((second_run, second_linked, second_orphans), (0, 0, 0))
        self.assertEqual(connection.execute("SELECT count(*) FROM nodes").fetchone()[0], 4)
        archive.close()
        connection.close()

    def test_href_resolver_rejects_non_context_and_traversal_targets(self) -> None:
        self.assertEqual(
            importer.resolve_internal_href(
                "catalog/group.html",
                "v8help://SyntaxHelperContext/objects/catalog/group/methods/Action.html#syntax",
            ),
            "catalog/group/methods/Action.html",
        )
        self.assertIsNone(importer.resolve_internal_href("catalog/group.html", "../../../../outside.html"))
        self.assertIsNone(importer.resolve_internal_href("catalog/group.html", "v8help://SyntaxHelperLanguage/def_String"))
        self.assertIsNone(importer.resolve_internal_href("catalog/group.html", "https://example.test/page.html"))

    def test_zip_member_validation_rejects_path_traversal(self) -> None:
        archive = make_zip({"objects/../outside.html": b"<html></html>"})
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP member path"):
            importer.object_html_infos(archive)
        archive.close()

    def test_bundled_database_integrity_and_current_date_article(self) -> None:
        database_path = Path(__file__).resolve().parents[1] / "resources" / "help" / "shcntx_help.db"
        connection = sqlite3.connect(database_path)
        try:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("SELECT count(*) FROM nodes").fetchone()[0], 24_787)
            linked_rows = connection.execute("SELECT node_id, markdown FROM article_markdown ORDER BY node_id").fetchall()
            self.assertGreater(len(linked_rows), 0)
            self.assertTrue(any(node_id <= 2673 for node_id, _markdown in linked_rows))
            node_ids = {row[0] for row in connection.execute("SELECT id FROM nodes")}
            link_targets = {
                int(match.group(1))
                for _node_id, markdown in linked_rows
                for match in re.finditer(r"bsl-help:syntax:(\d+)", markdown)
            }
            self.assertTrue(link_targets)
            self.assertTrue(link_targets <= node_ids)
            self.assertTrue(any(
                node_id <= 2673 and target_id > 2673
                for node_id, markdown in linked_rows
                for target_id in (int(match.group(1)) for match in re.finditer(r"bsl-help:syntax:(\d+)", markdown))
            ))
            article = connection.execute(
                "SELECT name, content FROM nodes WHERE path = ?",
                ("Global context/methods/catalog4840/CurrentDate956.html",),
            ).fetchone()
            self.assertIsNotNone(article)
            assert article is not None
            self.assertEqual(article[0], "ТекущаяДата (CurrentDate)")
            self.assertIn("ТекущаяДата()", article[1])
            self.assertIn("Возвращаемое значение:", article[1])
            self.assertIn("Синтаксис:\n\nТекущаяДата()", article[1])
            self.assertIn("Возвращаемое значение:\n\nТип: Дата", article[1])
            self.assertIn("Описание:", article[1])
            self.assertIn("Описание:\n\nОпределяет текущую (системную) дату", article[1])
            self.assertIn("Определяет текущую (системную) дату", article[1])
            importer.validate_hierarchy(importer.read_nodes(connection))
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
