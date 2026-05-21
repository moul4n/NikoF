import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mixamoVRMRigMap } from './mixamoVRMRigMap.js';

/**
 * Load Mixamo animation, convert for three-vrm use, and return it.
 * This is the EXACT same logic as the official three-vrm example,
 * with added debug logging so we can observe how retargeting works.
 *
 * @param {string} url A url of mixamo animation data
 * @param {import('@pixiv/three-vrm').VRM} vrm A target VRM
 * @returns {Promise<{clip: THREE.AnimationClip, debug: object}>}
 */
export function loadMixamoAnimation(url, vrm) {
  const loader = new FBXLoader();
  return loader.loadAsync(url).then((asset) => {
    const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com');

    const tracks = [];
    const debugInfo = {
      sourceHipsHeight: 0,
      vrmHipsHeight: 0,
      hipsPositionScale: 0,
      boneRetargetData: {},
      sourceSkeleton: {},
      trackSummary: [],
    };

    const restRotationInverse = new THREE.Quaternion();
    const parentRestWorldRotation = new THREE.Quaternion();
    const _quatA = new THREE.Quaternion();
    const _vec3 = new THREE.Vector3();

    // Capture source skeleton structure
    const hipsNode = asset.getObjectByName('mixamorigHips');
    debugInfo.sourceHipsHeight = hipsNode.position.y;
    debugInfo.vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips.position[1];
    debugInfo.hipsPositionScale = debugInfo.vrmHipsHeight / debugInfo.sourceHipsHeight;

    // Walk source skeleton to capture rest pose info
    for (const [mixamoName, vrmBoneName] of Object.entries(mixamoVRMRigMap)) {
      const node = asset.getObjectByName(mixamoName);
      if (node) {
        const worldQuat = new THREE.Quaternion();
        const worldPos = new THREE.Vector3();
        node.getWorldQuaternion(worldQuat);
        node.getWorldPosition(worldPos);

        const parentWorldQuat = new THREE.Quaternion();
        if (node.parent) {
          node.parent.getWorldQuaternion(parentWorldQuat);
        }

        debugInfo.sourceSkeleton[vrmBoneName] = {
          localPos: node.position.clone(),
          localQuat: node.quaternion.clone(),
          worldPos: worldPos,
          worldQuat: worldQuat,
          parentWorldQuat: parentWorldQuat,
          restRotationInverse: worldQuat.clone().invert(),
        };
      }
    }

    // Log VRM normalized rest pose for comparison
    debugInfo.vrmRestPose = vrm.humanoid.normalizedRestPose;

    const motionHipsHeight = hipsNode.position.y;
    const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips.position[1];
    const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

    clip.tracks.forEach((track) => {
      const trackSplitted = track.name.split('.');
      const mixamoRigName = trackSplitted[0];
      const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
      const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName)?.name;
      const mixamoRigNode = asset.getObjectByName(mixamoRigName);

      if (vrmNodeName != null) {
        const propertyName = trackSplitted[1];

        mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
        mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

        if (track instanceof THREE.QuaternionKeyframeTrack) {
          // Store pre-retarget first frame for debug
          const preRetargetFirst = track.values.slice(0, 4);

          for (let i = 0; i < track.values.length; i += 4) {
            const flatQuaternion = track.values.slice(i, i + 4);
            _quatA.fromArray(flatQuaternion);

            // parentRestWorldRotation * trackRotation * restRotationInverse
            _quatA
              .premultiply(parentRestWorldRotation)
              .multiply(restRotationInverse);

            _quatA.toArray(flatQuaternion);
            flatQuaternion.forEach((v, index) => {
              track.values[index + i] = v;
            });
          }

          const postRetargetFirst = track.values.slice(0, 4);

          // VRM0 coordinate flip
          const finalValues = track.values.map((v, i) =>
            vrm.meta?.metaVersion === '0' && i % 2 === 0 ? -v : v
          );

          tracks.push(
            new THREE.QuaternionKeyframeTrack(
              `${vrmNodeName}.${propertyName}`,
              track.times,
              finalValues,
            ),
          );

          // Store debug data for lower body bones
          const lowerBodyBones = [
            'hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
            'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
          ];
          if (lowerBodyBones.includes(vrmBoneName)) {
            debugInfo.boneRetargetData[vrmBoneName] = {
              preRetargetFirstFrame: Array.from(preRetargetFirst),
              postRetargetFirstFrame: Array.from(postRetargetFirst),
              finalFirstFrame: Array.from(finalValues.slice(0, 4)),
              totalFrames: track.times.length,
              duration: track.times[track.times.length - 1],
            };
          }

          debugInfo.trackSummary.push({
            bone: vrmBoneName,
            type: 'quaternion',
            frames: track.times.length,
            node: vrmNodeName,
          });

        } else if (track instanceof THREE.VectorKeyframeTrack) {
          const value = track.values.map((v, i) =>
            (vrm.meta?.metaVersion === '0' && i % 3 !== 1 ? -v : v) * hipsPositionScale
          );
          tracks.push(
            new THREE.VectorKeyframeTrack(
              `${vrmNodeName}.${propertyName}`,
              track.times,
              value,
            ),
          );

          if (vrmBoneName === 'hips') {
            // Capture hips position track data
            debugInfo.boneRetargetData['hips_position'] = {
              rawFirstFrame: Array.from(track.values.slice(0, 3)),
              scaledFirstFrame: Array.from(value.slice(0, 3)),
              scale: hipsPositionScale,
              totalFrames: track.times.length,
              // Sample a few frames of position data
              positionSamples: [],
            };
            for (let i = 0; i < Math.min(30, track.times.length); i++) {
              debugInfo.boneRetargetData['hips_position'].positionSamples.push({
                time: track.times[i],
                raw: Array.from(track.values.slice(i * 3, i * 3 + 3)),
                scaled: Array.from(value.slice(i * 3, i * 3 + 3)),
              });
            }
          }

          debugInfo.trackSummary.push({
            bone: vrmBoneName,
            type: 'position',
            frames: track.times.length,
            node: vrmNodeName,
          });
        }
      }
    });

    return {
      clip: new THREE.AnimationClip('vrmAnimation', clip.duration, tracks),
      debug: debugInfo,
    };
  });
}
