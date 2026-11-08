/**
 * Chrome offscreen document: hosts ONNX Runtime Web for local image
 * classification. Only reachable from the extension's own background via
 * runtime messages addressed to 'offscreen'.
 */
import { analyzeImage, loadModel, testModel } from '../inference/engine';
import { listen } from '../shared/messages';

listen('offscreen', {
  'off:analyze': (req) => analyzeImage(req),
  'off:reload': ({ backend }) => loadModel(backend),
  'off:test': ({ backend }) => testModel(backend),
  'off:ping': () => true,
});
