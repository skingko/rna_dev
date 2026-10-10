import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('migration', Path(__file__).resolve().parents[1] / 'migrate-openviking-semantic.py')
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def pack(path, content, vectors=False):
    with zipfile.ZipFile(path, 'w') as out:
        out.writestr('openviking-backup/_ovpack/manifest.json', json.dumps({
            'kind': 'openviking.ovpack', 'format_version': 3,
            'root': {'uri': 'viking://', 'package_type': 'backup'}}))
        for name, body in content.items():
            out.writestr('openviking-backup/files/' + name, body)
        if vectors:
            out.writestr('openviking-backup/_ovpack/dense.f32', b'old 64-dimensional vectors')


class MigrationTests(unittest.TestCase):
    def test_old_vectors_are_rejected_even_if_content_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'memory.ovpack'
            pack(path, {'resources/project/a.md': 'user source'}, vectors=True)
            with self.assertRaisesRegex(RuntimeError, 'old embedding vectors'):
                MIGRATION.manifest(path)

    def test_comparison_fails_for_changed_or_missing_original_but_allows_new_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source.ovpack', Path(directory) / 'target.ovpack'
            pack(source, {'resources/project/a.md': 'original'})
            for files, valid in [({'resources/project/a.md': 'original', 'user/new.md': 'new'}, True),
                                 ({'resources/project/a.md': 'changed'}, False), ({'user/new.md': 'new'}, False)]:
                pack(target, files)
                with patch('sys.argv', ['migration', 'compare', '--file', str(source), '--against', str(target)]), patch('sys.stdout', new_callable=io.StringIO) as output:
                    if valid:
                        MIGRATION.main()
                        self.assertTrue(json.loads(output.getvalue())['originalBytesPreserved'])
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Restored content mismatch'):
                            MIGRATION.main()

    def test_existing_backup_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.ovpack'
            path.write_bytes(b'original backup')
            with patch('sys.argv', ['migration', 'backup', '--file', str(path), '--container', 'rna-openviking', '--client', '/private/client.json', '--writers-stopped']), patch.object(MIGRATION, 'request') as request:
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    MIGRATION.main()
                request.assert_not_called()
                self.assertEqual(path.read_bytes(), b'original backup')

    def test_restore_requires_explicit_empty_target_and_stopped_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.ovpack'
            pack(path, {'resources/project/a.md': 'original'})
            with patch('sys.argv', ['migration', 'restore', '--file', str(path), '--container', 'rna-openviking-semantic', '--client', '/private/client.json', '--writers-stopped']), patch.object(MIGRATION, 'request') as request, patch('sys.stderr', new_callable=io.StringIO):
                with self.assertRaises(SystemExit):
                    MIGRATION.main()
                request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
