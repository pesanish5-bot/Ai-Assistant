# Third-party local voice models

Ultron keeps these model files outside the Git repository under the configured
private model cache. Their notices and licenses must remain available whenever
the models are redistributed.

The downloader verifies the official sherpa-onnx release checksums before
installing these artifacts:

- `silero_vad.onnx`: `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`
- `kokoro-en-v0_19.tar.bz2`: `912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7`

## WeSpeaker CAM++ English speaker embedding

- File: `wespeaker_en_voxceleb_CAM++.onnx`
- Sherpa-ONNX release: <https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models>
- Upstream project: <https://github.com/wenet-e2e/wespeaker>
- Upstream model: <https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus>
- Software license: Apache License 2.0
- VoxCeleb-trained model license: Creative Commons Attribution 4.0
- SHA-256: `c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef`

This notice does not replace the upstream licenses. Review the linked model
card and WeSpeaker pretrained-model policy before redistribution.
