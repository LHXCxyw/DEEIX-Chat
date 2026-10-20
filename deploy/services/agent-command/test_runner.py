import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

import runner


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.previous = os.getcwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)

    def tearDown(self):
        os.chdir(self.previous)
        self.temp.cleanup()

    def request(self, files=None):
        return {"protocol": 1, "argv": [sys.executable, "-c", "import sys; print('out'); print('err',file=sys.stderr); sys.exit(7)"],
                "files": files or [], "snapshot_hash": "bound-hash", "timeout_seconds": 2}

    @unittest.skipUnless(os.name == "posix", "真实执行与进程组清理仅支持 Linux runner")
    def test_real_exit_and_separate_output(self):
        result = runner.run(self.request())
        self.assertEqual(result["exit_code"], 7)
        self.assertEqual(result["stdout"].strip(), "out")
        self.assertEqual(result["stderr"].strip(), "err")
        self.assertFalse(result["persistent_changes"])
        self.assertEqual(result["snapshot_hash"], "bound-hash")

    def test_reject_path_and_hash(self):
        for name, digest in [("../evil.py", hashlib.sha256(b"hello").hexdigest()),
                             ("a.py", "bad")]:
            with self.assertRaises(ValueError):
                runner.run(self.request([{"path": name, "content": "hello", "sha256": digest}]))

    def test_missing_executable(self):
        request = self.request()
        request["argv"] = ["/not-present/deeix-command"]
        self.assertEqual(runner.run(request)["exit_code"], 127)

    def test_healthcheck_protocol(self):
        result = subprocess.run([sys.executable, runner.__file__, "--healthcheck"], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {
            "runner": "deeix-agent-command",
            "version": "1.0.0",
            "protocol": 1,
            "status": "ok",
        })


if __name__ == "__main__":
    unittest.main()
