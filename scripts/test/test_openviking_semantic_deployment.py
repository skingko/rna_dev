"""Deployment contracts only. Real inference evidence belongs to the E2E report."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('semantic_local', Path(__file__).resolve().parents[1] / 'openviking-local.py')
LOCAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCAL)


class SemanticDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.runtime = patch.object(LOCAL, 'RUNTIME', self.directory)
        self.mode = patch.object(LOCAL, 'FIXTURE', False)
        self.native = patch.object(LOCAL, 'NATIVE_EMBEDDING', False)
        self.runtime.start(); self.mode.start(); self.native.start()
        self.addCleanup(self.native.stop)
        self.addCleanup(self.temp.cleanup); self.addCleanup(self.runtime.stop); self.addCleanup(self.mode.stop)

    def models(self, **changes):
        vlm = {'provider':'openai','api_base':'https://text-model.example/v1','api_key':'fixture-only-private-key',
               'model':'real-text-model','timeout':120,'max_tokens':4096,'max_retries':1,'max_concurrent':2}
        vlm.update(changes)
        LOCAL.write_private(self.directory / 'models.json', {'vlm':vlm})

    def test_default_missing_real_models_fails_without_creating_fixture(self):
        with self.assertRaisesRegex(RuntimeError, 'Real memory requires'):
            LOCAL.configure()
        self.assertFalse((self.directory / 'ov.conf').exists())

    def test_real_config_locks_exact_embedding_and_preserves_root_key(self):
        self.models(); LOCAL.configure()
        first=json.loads((self.directory/'ov.conf').read_text())
        self.assertEqual(first['embedding']['dense']['dimension'],1024)
        self.assertEqual(first['embedding']['dense']['model'],'bge-m3:latest')
        self.assertEqual(first['embedding']['dense']['encoding_format'],'float')
        self.assertNotIn('model-fixture',json.dumps(first))
        self.models(model='new-real-text-model'); LOCAL.configure()
        second=json.loads((self.directory/'ov.conf').read_text())
        self.assertEqual(first['server']['root_api_key'],second['server']['root_api_key'])
        self.assertEqual(second['vlm']['model'],'new-real-text-model')
        self.assertEqual(json.loads((self.directory/'model-identity.json').read_text()),LOCAL.MODEL_IDENTITY)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in self.directory.iterdir()))

    def test_fixture_model_in_real_profile_and_insecure_secret_file_rejected(self):
        self.models(model='rna-fixture-summary')
        with self.assertRaisesRegex(RuntimeError,'fixtures are forbidden'):LOCAL.configure()
        self.models(); os.chmod(self.directory/'models.json',0o644)
        with self.assertRaisesRegex(RuntimeError,'0600'):LOCAL.configure()

    def test_real_text_requests_receive_bounded_defaults_and_reject_unbounded_limits(self):
        self.models(); path=self.directory/'models.json'; supplied=json.loads(path.read_text())
        for name in ('timeout','max_tokens','max_retries','max_concurrent'):supplied['vlm'].pop(name)
        LOCAL.write_private(path,supplied);LOCAL.configure()
        vlm=json.loads((self.directory/'ov.conf').read_text())['vlm']
        self.assertEqual({name:vlm[name] for name in ('timeout','max_tokens','max_retries','max_concurrent')},
                         {'timeout':120,'max_tokens':4096,'max_retries':1,'max_concurrent':2})
        for name,value in [('timeout',0),('max_tokens',100000),('max_retries',1000),('max_concurrent',True)]:
            self.models(**{name:value})
            with self.assertRaisesRegex(RuntimeError,'outside supported bounds'):LOCAL.configure()

    def test_existing_dimension_or_model_lock_cannot_be_silently_replaced(self):
        self.models(); LOCAL.configure()
        path=self.directory/'ov.conf'; original=json.loads(path.read_text())
        altered=json.loads(path.read_text()); altered['embedding']['dense']['dimension']=64
        LOCAL.write_private(path,altered)
        with self.assertRaisesRegex(RuntimeError,'Embedding identity changed'):LOCAL.configure()
        self.assertEqual(json.loads(path.read_text())['embedding']['dense']['dimension'],64)
        LOCAL.write_private(path,original)
        LOCAL.write_private(self.directory/'model-identity.json',{**LOCAL.MODEL_IDENTITY,'manifestDigest':'changed'})
        with self.assertRaisesRegex(RuntimeError,'identity lock'):LOCAL.configure()

    def test_deepseek_summary_defaults_disable_thinking_without_changing_request_budget(self):
        self.models(api_base='https://api.deepseek.com/v1', model='deepseek-flash')
        LOCAL.configure()
        vlm=json.loads((self.directory/'ov.conf').read_text())['vlm']
        self.assertEqual(vlm['extra_request_body'], {'thinking': {'type': 'disabled'}})
        self.assertEqual(vlm['max_tokens'], 4096)
        self.models(extra_request_body={'thinking': {'type': 'disabled'}})
        LOCAL.configure()
        self.assertEqual(json.loads((self.directory/'ov.conf').read_text())['vlm']['extra_request_body'],
                         {'thinking': {'type': 'disabled'}})

    def test_extra_request_body_cannot_override_limits_or_enable_unbounded_reasoning(self):
        for extra in [None, {}, [], {'thinking': {'type': 'enabled'}},
                      {'thinking': {'type': 'disabled', 'budget_tokens': 100000}},
                      {'thinking': {'type': 'disabled'}, 'max_tokens': 100000},
                      {'thinking': {'type': 'disabled'}, 'model': 'other-model'}]:
            with self.subTest(extra=extra):
                self.models(extra_request_body=extra)
                with self.assertRaisesRegex(RuntimeError, 'Only extra_request_body'):LOCAL.configure()
        self.assertFalse((self.directory/'ov.conf').exists())

    def test_missing_or_corrupt_private_server_auth_never_rotates_or_disables_auth(self):
        self.models();LOCAL.configure();path=self.directory/'ov.conf';original=path.read_text()
        path.unlink()
        with self.assertRaisesRegex(RuntimeError,'silently rotating'):LOCAL.configure()
        self.assertFalse(path.exists())
        changed=json.loads(original);changed['server']['root_api_key']=''
        LOCAL.write_private(path,changed)
        with self.assertRaisesRegex(RuntimeError,'authentication is invalid'):LOCAL.configure()
        self.assertEqual(json.loads(path.read_text())['server']['root_api_key'],'')

    def test_helper_points_only_at_new_container_and_configuration_has_no_process_effect(self):
        with patch.object(LOCAL.shutil,'which',return_value='/bin/echo'), patch.object(LOCAL.subprocess,'run') as run, patch.object(LOCAL.subprocess,'Popen') as popen:
            LOCAL.configure_helper()
        run.assert_not_called(); popen.assert_not_called()
        relay=json.loads((self.directory/'relay.json').read_text())
        self.assertEqual(relay['container'],'rna-openviking-semantic')
        self.assertEqual(relay['port'],1933)

    def test_prepare_never_adds_host_ports_or_configures_helper_and_pins_engine(self):
        with patch.object(sys,'argv',['openviking-local.py','prepare','--desktop-relay']), patch.object(LOCAL.shutil,'which',return_value='/bin/echo'), patch.object(LOCAL,'configure_helper') as helper, patch.object(LOCAL,'stage_semantic') as stage, patch.dict(os.environ,{'DOCKER_CONTEXT':'foreign','DOCKER_HOST':'unix:///foreign.sock'}):
            LOCAL.main()
        helper.assert_not_called()
        compose,docker,environment=stage.call_args.args
        self.assertTrue(str(LOCAL.DEPLOY/'compose.yaml') in compose)
        self.assertFalse(any('compose.direct' in part for part in compose))
        self.assertEqual(docker[1],'--host')
        self.assertTrue(docker[2].endswith('/Data/docker.raw.sock'))
        self.assertNotIn('DOCKER_CONTEXT',environment); self.assertNotIn('DOCKER_HOST',environment)

    def test_native_runtime_keeps_model_identity_and_excludes_container_embedding(self):
        self.models(); LOCAL.configure(); original=json.loads((self.directory/'model-identity.json').read_text())
        with patch.object(LOCAL,'NATIVE_EMBEDDING',True):LOCAL.configure()
        config=json.loads((self.directory/'ov.conf').read_text())
        self.assertEqual(config['embedding']['dense']['api_base'],'http://host.docker.internal:11434/v1')
        self.assertEqual(json.loads((self.directory/'model-identity.json').read_text()),original)
        with patch.object(sys,'argv',['openviking-local.py','prepare','--desktop-relay']), patch.object(LOCAL.shutil,'which',return_value='/bin/echo'), patch.object(LOCAL,'stage_semantic') as stage:
            LOCAL.main()
        self.assertIn(str(LOCAL.DEPLOY/'compose.native-embedding.yaml'),stage.call_args.args[0])
        self.assertNotIn(str(LOCAL.DEPLOY/'compose.direct.yaml'),stage.call_args.args[0])

    def test_native_helper_descriptor_has_strict_identity_without_starting_binary(self):
        with patch.object(LOCAL.subprocess,'run') as run, patch.object(LOCAL.subprocess,'Popen') as popen:
            descriptor=LOCAL.configure_embedding_helper('/bin/echo')
        run.assert_not_called();popen.assert_not_called()
        self.assertEqual(descriptor['id'],'openviking-embedding')
        self.assertEqual(descriptor['healthIdentity'],'rna-helper-v1')
        self.assertEqual(descriptor['healthUrl'],'http://127.0.0.1:11435/_rna/health')
        config=json.loads((self.directory/'embedding-helper.json').read_text())
        self.assertEqual(config['modelDigest'],LOCAL.MODEL_DIGEST)
        self.assertEqual(config['ollamaHost'],'127.0.0.1')

    def test_default_compose_contains_only_real_service_and_separate_volumes(self):
        content=(LOCAL.DEPLOY/'compose.yaml').read_text()
        self.assertNotIn('model-fixture',content)
        self.assertNotIn('ports:',content)
        self.assertIn(LOCAL.DATA_VOLUME,content)
        self.assertNotIn('name: rna-openviking-data\n',content)
        self.assertIn('ollama/ollama:0.34.4@sha256:',content)
        legacy=(LOCAL.DEPLOY/'compose.fixture.yaml').read_text()
        self.assertIn('name: rna-openviking-data\n',legacy)
        self.assertIn('model-fixture:',legacy)

    def test_changed_downloaded_weights_stop_before_any_openviking_start_or_config_copy(self):
        self.models()
        calls=[]
        def run(command,**kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command,0,stdout=b'wrong model manifest',stderr=b'')
        with patch.object(LOCAL.subprocess,'run',side_effect=run):
            with self.assertRaisesRegex(RuntimeError,'manifest differs'):
                LOCAL.stage_semantic(['docker','compose'],['docker'],{})
        self.assertEqual(len(calls),2)
        self.assertFalse(any('cp' in command or 'openviking' in command for command in calls))

    def test_candidate_request_keeps_secret_and_payload_out_of_argv_and_error(self):
        secret='private-secret-not-in-argv'
        outcome=subprocess.CompletedProcess([],0,stdout=json.dumps({'status':200,'body':{'ok':True}}),stderr='')
        with patch.object(LOCAL.subprocess,'run',return_value=outcome) as run:
            result=LOCAL.docker_http(['docker'],{},'POST','/api/v1/admin/accounts',secret,{'private':'body'})
        self.assertEqual(result,{'ok':True})
        self.assertNotIn(secret,repr(run.call_args.args))
        self.assertIn(secret,run.call_args.kwargs['input'])
        outcome.stdout=json.dumps({'status':401,'body':{'detail':secret}})
        with patch.object(LOCAL.subprocess,'run',return_value=outcome):
            with self.assertRaisesRegex(RuntimeError,'status 401') as caught:
                LOCAL.docker_http(['docker'],{},'GET','/ready',secret)
        self.assertNotIn(secret,str(caught.exception))


if __name__ == '__main__':unittest.main()
