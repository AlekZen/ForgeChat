#!/usr/bin/env python3
"""Publish owned IA360 changes through n8n's authenticated HTTP MCP API.

Read-before-write drift checks are NOT atomic CAS against other editors. A local
flock serializes this operator; each update is atomic in n8n, publication targets
an explicit version, and every effect is read back. No CLI import, SQL mutation,
blind retry, or automatic rollback over another operator's changes.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('/home/alek/.config/diapazo/forgechat-musio-20260908/n8n')
ORDER = ['IA360CalendarBook20260602', 'rV1z5sUdNEzCQ1tk', 'sjrkjf7IcM7ski0n', 'F1sj5tcJVa9R3Q9Z', 'IA360ContactIntelDraft20260605']
MANIFEST = json.loads((ROOT / 'manifest/cutover-manifest.json').read_text())
DRAFTS = dict(MANIFEST['active_baselines'])
DRAFTS['IA360ContactIntelDraft20260605'] = '4cacd72f-6788-4585-8d39-d3c03e5bb84a'
NODE_SETTINGS = ('onError', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce')
ADD_FIELDS = ('id', 'name', 'type', 'typeVersion', 'parameters', 'position', 'credentials', 'disabled', 'notes')


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    path.chmod(0o600)


def query(sql):
    raw = subprocess.check_output(['docker', 'exec', 'n8n-postgres', 'psql', '-U', 'n8n', '-d', 'n8n', '-t', '-A', '-c', sql], text=True)
    return json.loads(raw)


def current(wid):
    if wid not in ORDER:
        raise ValueError('workflow_not_owned')
    return query('SELECT row_to_json(w) FROM (SELECT id,name,active,"versionId","activeVersionId",nodes,connections,settings FROM workflow_entity WHERE id=' + "'" + wid + "') w")


def historical(wid, version):
    if wid not in ORDER or not all(c in '0123456789abcdef-' for c in version):
        raise ValueError('invalid_history_identity')
    return query('SELECT row_to_json(w) FROM (SELECT "versionId",nodes,connections FROM workflow_history WHERE "workflowId"=' + "'" + wid + "' AND \"versionId\"='" + version + "') w")


def edges(graph):
    return {(source, target['node'], typ, output, target.get('index', 0))
            for source, types in graph.get('connections', {}).items()
            for typ, outputs in types.items() for output, targets in enumerate(outputs)
            for target in (targets or [])}


def semantic(graph):
    nodes = []
    for node in graph['nodes']:
        selected = {k: node[k] for k in ('name', 'type', 'typeVersion', 'parameters', 'credentials', *NODE_SETTINGS) if k in node}
        if node.get('disabled'):
            selected['disabled'] = True
        nodes.append(selected)
    return {'nodes': sorted(nodes, key=lambda n: n['name']), 'edges': sorted(edges(graph))}


def digest(graph):
    return hashlib.sha256(json.dumps(semantic(graph), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def candidate(wid):
    return json.loads((ROOT / 'candidates' / (wid + '.candidate.json')).read_text())


def operations(before, after):
    old = {n['name']: n for n in before['nodes']}
    new = {n['name']: n for n in after['nodes']}
    if len(new) != len(after['nodes']):
        raise ValueError('duplicate_node_name')
    replaced = {name for name in old.keys() & new.keys() if (old[name]['type'], old[name].get('typeVersion')) != (new[name]['type'], new[name].get('typeVersion'))}
    removed = (old.keys() - new.keys()) | replaced
    added = (new.keys() - old.keys()) | replaced
    ops = []
    for source, target, typ, output, index in sorted(edges(before) - edges(after)):
        ops.append({'type': 'removeConnection', 'source': source, 'target': target, 'connectionType': typ, 'sourceIndex': output, 'targetIndex': index})
    for name in sorted(removed):
        ops.append({'type': 'removeNode', 'nodeName': name})
    for name in sorted(added):
        node = new[name]
        ops.append({'type': 'addNode', 'node': {k: node[k] for k in ADD_FIELDS if k in node}})
    for name in sorted(new):
        node, previous = new[name], old.get(name, {}) if name not in added else {}
        if name not in added and node.get('parameters', {}) != previous.get('parameters', {}):
            ops.append({'type': 'updateNodeParameters', 'nodeName': name, 'parameters': node.get('parameters', {}), 'replace': True})
        settings = {k: node[k] for k in NODE_SETTINGS if k in node and node[k] != previous.get(k)}
        missing = [k for k in NODE_SETTINGS if k in previous and k not in node]
        if missing:
            raise ValueError('unsupported_settings_removal:' + name + ':' + ','.join(missing))
        if settings:
            ops.append({'type': 'setNodeSettings', 'nodeName': name, 'settings': settings})
        if name not in added:
            if bool(node.get('disabled')) != bool(previous.get('disabled')):
                ops.append({'type': 'setNodeDisabled', 'nodeName': name, 'disabled': bool(node.get('disabled'))})
            for key, credential in node.get('credentials', {}).items():
                if credential != previous.get('credentials', {}).get(key):
                    ops.append({'type': 'setNodeCredential', 'nodeName': name, 'credentialKey': key, 'credentialId': credential['id'], 'credentialName': credential['name']})
    retained_edges = {e for e in edges(before) & edges(after) if e[0] not in removed and e[1] not in removed}
    for source, target, typ, output, index in sorted(edges(after) - retained_edges):
        if source not in new or target not in new:
            raise ValueError('connection_target_missing')
        ops.append({'type': 'addConnection', 'source': source, 'target': target, 'connectionType': typ, 'sourceIndex': output, 'targetIndex': index})
    if len(ops) > 100:
        raise ValueError('atomic_update_exceeds_100_operations')
    return ops


class MCP:
    def __init__(self):
        inspect = json.loads(subprocess.check_output(['docker', 'inspect', 'n8n'], text=True))[0]
        env = dict(entry.split('=', 1) for entry in inspect['Config']['Env'])
        token = env.get('N8N_MCP_ACCESS_TOKEN')
        if not token:
            raise ValueError('missing_n8n_mcp_access_token')
        self.headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        self.serial = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'musio-reviewed-publisher', 'version': '1'}})

    def rpc(self, method, params):
        self.serial += 1
        payload = {'jsonrpc': '2.0', 'id': self.serial, 'method': method, 'params': params}
        request = urllib.request.Request('http://127.0.0.1:5678/mcp-server/http', data=json.dumps(payload).encode(), headers=self.headers)
        with urllib.request.urlopen(request, timeout=90) as response:
            if response.headers.get('Mcp-Session-Id'):
                self.headers['Mcp-Session-Id'] = response.headers['Mcp-Session-Id']
            raw = response.read().decode()
        entries = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ')] if raw.startswith('event:') else [json.loads(raw)]
        result = next(entry for entry in entries if entry.get('id') == self.serial)
        if 'error' in result:
            raise RuntimeError('mcp_protocol_error:' + str(result['error'].get('code')))
        return result['result']

    def call(self, name, arguments):
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        data = result.get('structuredContent')
        if data is None:
            parts = [item['text'] for item in result.get('content', []) if item.get('type') == 'text']
            data = json.loads(parts[0]) if parts else {}
        if result.get('isError') or data.get('error') or data.get('success') is False:
            # No payload dump: workflow errors can contain confidential node data.
            raise RuntimeError('n8n_tool_failed:' + name + ':' + str(data.get('reason', 'inspect_private_journal')))
        return data


def assert_version(wid, active, draft):
    value = current(wid)
    if value['activeVersionId'] != active or value['versionId'] != draft:
        raise RuntimeError('workflow_drift:' + wid)
    return value


def plan():
    rows = []
    for wid in ORDER:
        before = assert_version(wid, MANIFEST['active_baselines'][wid], DRAFTS[wid])
        after = candidate(wid)
        ops = operations(before, after)
        rows.append({'workflow': wid, 'operations': len(ops), 'candidate_hash': digest(after), 'active': before['activeVersionId'], 'draft': before['versionId']})
    # Authenticate only; this does not execute a workflow.
    api = MCP()
    api.call('get_workflow_details', {'workflowId': ORDER[-1], 'detailLevel': 'execution'})
    return rows


def apply():
    rows = plan()
    print(json.dumps({'plan': rows}))
    state_path = PRIVATE / 'publication.json'
    if state_path.exists():
        raise RuntimeError('publication_journal_exists_inspect_before_retry')
    journal = {'entries': []}
    private_write(state_path, journal)
    api = MCP()
    for wid in ORDER:
        before = assert_version(wid, MANIFEST['active_baselines'][wid], DRAFTS[wid])
        after = candidate(wid)
        private_write(PRIVATE / (wid + '.before.json'), {'draft': before, 'active': historical(wid, before['activeVersionId'])})
        entry = {'workflow': wid, 'old_active': before['activeVersionId'], 'old_draft': before['versionId'], 'candidate_hash': digest(after), 'stage': 'before_update'}
        journal['entries'].append(entry)
        private_write(state_path, journal)
        ops = operations(before, after)
        if ops:
            result = api.call('update_workflow', {'workflowId': wid, 'operations': ops, 'versionName': 'Problem16: owner-authorized agenda', 'versionDescription': 'Reviewed Musio repair. Preserve source scope, external authorization and verified provider result.'})
            if result.get('appliedOperations') != len(ops) or result.get('skippedOperations'):
                raise RuntimeError('update_operations_not_applied:' + wid)
        updated = current(wid)
        entry.update(new_draft=updated['versionId'], stage='updated')
        private_write(state_path, journal)
        if updated['activeVersionId'] != before['activeVersionId'] or digest(updated) != digest(after):
            raise RuntimeError('draft_readback_mismatch:' + wid)
        assert_version(wid, before['activeVersionId'], updated['versionId'])
        api.call('publish_workflow', {'workflowId': wid, 'versionId': updated['versionId']})
        live = assert_version(wid, updated['versionId'], updated['versionId'])
        if digest(historical(wid, live['activeVersionId'])) != digest(after):
            raise RuntimeError('published_graph_readback_mismatch:' + wid)
        # Confirm the HTTP service observes the exact published version too.
        public = api.call('get_workflow_details', {'workflowId': wid, 'detailLevel': 'execution'})['workflow']
        if public['activeVersionId'] != updated['versionId']:
            raise RuntimeError('runtime_version_readback_mismatch:' + wid)
        entry.update(new_active=live['activeVersionId'], stage='published')
        private_write(state_path, journal)
        if before['versionId'] != before['activeVersionId']:
            api.call('restore_workflow_version', {'workflowId': wid, 'versionId': before['versionId']})
            restored = current(wid)
            if restored['activeVersionId'] != live['activeVersionId'] or digest(restored) != digest(before):
                raise RuntimeError('preserved_draft_readback_mismatch:' + wid)
            entry['preserved_draft_version'] = restored['versionId']
            entry['stage'] = 'published_draft_preserved'
            private_write(state_path, journal)
        print(json.dumps({'workflow': wid, 'activeVersionId': live['activeVersionId'], 'readback': True}))


def rollback():
    path = PRIVATE / 'publication.json'
    journal = json.loads(path.read_text())
    api = MCP()
    for entry in reversed(journal['entries']):
        wid = entry['workflow']
        if entry['stage'] == 'before_update':
            raise RuntimeError('ambiguous_update_requires_inspection:' + wid)
        expected_active = entry.get('new_active', entry['old_active'])
        expected_draft = entry.get('preserved_draft_version', entry['new_draft'])
        assert_version(wid, expected_active, expected_draft)
        if entry.get('new_active'):
            api.call('publish_workflow', {'workflowId': wid, 'versionId': entry['old_active']})
        api.call('restore_workflow_version', {'workflowId': wid, 'versionId': entry['old_draft']})
        restored = current(wid)
        before = json.loads((PRIVATE / (wid + '.before.json')).read_text())
        if restored['activeVersionId'] != entry['old_active'] or digest(restored) != digest(before['draft']):
            raise RuntimeError('rollback_readback_failed:' + wid)
        entry['stage'] = 'rolled_back'
        private_write(path, journal)
        print(json.dumps({'workflow': wid, 'rollback_readback': True}))


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    PRIVATE.chmod(0o700)
    with (PRIVATE / 'publisher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            apply()
        elif args.rollback:
            rollback()
        else:
            print(json.dumps({'dry_run': True, 'workflow_mutations': 0, 'plan': plan()}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
