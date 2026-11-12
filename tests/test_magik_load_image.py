import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def install_stubs(input_dir):
    folder_paths = types.ModuleType("folder_paths")
    # Current ComfyUI keeps input/output/temp out of folder_names_and_paths.
    folder_paths.folder_names_and_paths = {"checkpoints": (["/nonexistent/models/checkpoints"], {".safetensors"})}
    folder_paths.input_directory = str(input_dir)

    def get_input_directory():
        return folder_paths.input_directory

    def get_filename_list(folder_name):
        folders = folder_paths.folder_names_and_paths[folder_name]
        return []

    def get_annotated_filepath(name, default_dir=None):
        base = default_dir or get_input_directory()
        return os.path.abspath(os.path.join(base, name))

    def exists_annotated_filepath(name):
        return os.path.exists(get_annotated_filepath(name))

    folder_paths.get_input_directory = get_input_directory
    folder_paths.get_filename_list = get_filename_list
    folder_paths.get_annotated_filepath = get_annotated_filepath
    folder_paths.exists_annotated_filepath = exists_annotated_filepath
    sys.modules["folder_paths"] = folder_paths

    server = types.ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    sys.modules["server"] = server

    node_helpers = types.ModuleType("node_helpers")
    node_helpers.pillow = lambda op, *args, **kwargs: op(*args, **kwargs)
    sys.modules["node_helpers"] = node_helpers

    for name in ("torch", "numpy"):
        sys.modules[name] = types.ModuleType(name)

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.ModuleType("aiohttp.web")
    sys.modules["aiohttp"] = aiohttp
    sys.modules["aiohttp.web"] = aiohttp.web

    pil = types.ModuleType("PIL")
    pil.Image = types.ModuleType("PIL.Image")
    pil.ImageOps = types.ModuleType("PIL.ImageOps")
    pil.ImageSequence = types.ModuleType("PIL.ImageSequence")
    sys.modules["PIL"] = pil
    sys.modules["PIL.Image"] = pil.Image
    sys.modules["PIL.ImageOps"] = pil.ImageOps
    sys.modules["PIL.ImageSequence"] = pil.ImageSequence

    return folder_paths


def load_module():
    spec = importlib.util.spec_from_file_location("magik_load_image", REPO_ROOT / "magik_load_image.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class InputTypesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.input_dir = Path(self.tmp.name) / "input"
        (self.input_dir / "sub").mkdir(parents=True)
        for name in ("a.png", "b.JPG", "c.webp", "note.txt"):
            (self.input_dir / name).touch()
        (self.input_dir / "sub" / "d.jpeg").touch()
        (self.input_dir / "sub" / "e.txt").touch()
        self.folder_paths = install_stubs(self.input_dir)
        self.module = load_module()

    def tearDown(self):
        self.tmp.cleanup()

    def test_get_filename_list_input_is_not_a_category(self):
        # Documents the regression scenario: current ComfyUI raises KeyError for "input".
        with self.assertRaises(KeyError):
            self.folder_paths.get_filename_list("input")

    def test_input_types_lists_images_recursively(self):
        image_input = self.module.MagikLoadImage.INPUT_TYPES()["required"]["image"]
        self.assertEqual(image_input[1], {"image_upload": True})
        self.assertEqual(image_input[0], ["a.png", "b.JPG", "c.webp", "sub/d.jpeg"])

    def test_input_types_empty_when_input_dir_missing(self):
        self.folder_paths.input_directory = str(self.input_dir / "does-not-exist")
        image_input = self.module.MagikLoadImage.INPUT_TYPES()["required"]["image"]
        self.assertEqual(image_input[0], [])


if __name__ == "__main__":
    unittest.main()
