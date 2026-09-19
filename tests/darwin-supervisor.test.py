"""Portable checks for cleanup decisions, not evidence of Darwin kernel behavior."""
import importlib.util
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'packages/infra-platform/src'
sys.path.insert(0, str(source))
spec = importlib.util.spec_from_file_location('darwin', source / 'darwin-supervisor.py')
darwin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(darwin)


class Child:
    def poll(self):
        return None


class CleanupTests(unittest.TestCase):
    def test_empty_enumeration_does_not_prove_cleanup(self):
        with patch.object(darwin, 'active', return_value=2), patch.object(darwin, 'members', return_value=[]), patch.object(darwin.time, 'monotonic', side_effect=[0, 0, 7]), patch.object(darwin.time, 'sleep'):
            self.assertFalse(darwin.cleanup(None, 42, Child()))

    def test_stop_delivery_without_stopped_state_never_kills(self):
        member = {'pid': 123, 'pidversion': 456, 'coalition': 42}
        with patch.object(darwin, 'active', return_value=2), patch.object(darwin, 'members', return_value=[member]), patch.object(darwin, 'stopped', return_value=False), patch.object(darwin, 'send') as send, patch.object(darwin.time, 'monotonic', side_effect=[0, 0, 7]), patch.object(darwin.time, 'sleep'):
            self.assertFalse(darwin.cleanup(None, 42, Child()))
            self.assertEqual([call.args[2] for call in send.call_args_list], [signal.SIGSTOP])

    def test_kill_requires_frozen_members_and_kernel_count_then_empty_proof(self):
        member = {'pid': 123, 'pidversion': 456, 'coalition': 42}
        with patch.object(darwin, 'active', side_effect=[2, 2, 1]), patch.object(darwin, 'members', return_value=[member]), patch.object(darwin, 'stopped', return_value=True), patch.object(darwin, 'send') as send, patch.object(darwin.time, 'sleep'):
            self.assertTrue(darwin.cleanup(None, 42, Child()))
            self.assertEqual([call.args[2] for call in send.call_args_list], [signal.SIGSTOP, signal.SIGKILL])

    def test_unobserved_member_prevents_killing_waited_on_child(self):
        member = {'pid': 123, 'pidversion': 456, 'coalition': 42}
        with patch.object(darwin, 'active', return_value=3), patch.object(darwin, 'members', return_value=[member]), patch.object(darwin, 'stopped', return_value=True), patch.object(darwin, 'send') as send, patch.object(darwin.time, 'monotonic', side_effect=[0, 0, 7]), patch.object(darwin.time, 'sleep'):
            self.assertFalse(darwin.cleanup(None, 42, Child()))
            self.assertEqual([call.args[2] for call in send.call_args_list], [signal.SIGSTOP])

    def test_dead_supervisor_without_proof_stays_unsettled(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(darwin, 'boot_id', return_value='boot'):
            directory = Path(temp)
            darwin.persist(directory, 'owner.json', {'boot': 'boot'})
            self.assertFalse(darwin.recover(directory)['settled'])
            self.assertTrue((directory / 'cancel').exists())
            self.assertFalse((directory / 'result.json').exists())

    def test_recovery_reservation_prevents_late_launch_and_reboot_clears_old_owner(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(darwin, 'boot_id', return_value='new'):
            directory = Path(temp)
            darwin.persist(directory, 'owner.json', {'boot': 'old'})
            self.assertTrue(darwin.recover(directory)['settled'])
            self.assertTrue((directory / 'cancel').exists())


if __name__ == '__main__':
    unittest.main()
