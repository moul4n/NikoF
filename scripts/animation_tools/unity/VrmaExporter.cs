using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace NikoF.AnimationTools
{
    /// <summary>
    /// Exports Unity humanoid .anim clips as VRMA files (.glb with VRMC_vrm_animation extension).
    /// The VRMA format preserves the animation skeleton's rest-pose rotations, enabling proper
    /// retargeting by three-vrm on the frontend without losing natural posture.
    /// </summary>
    public static class VrmaExporter
    {
        private const int FrameRate = 30;
        private const float ValueQuantizationFactor = 1000000f;

        // VRM humanoid bone names in the order we create nodes
        private static readonly string[] HumanoidBoneNames =
        {
            "hips", "spine", "chest", "upperChest", "neck", "head",
            "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
            "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
            "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
            "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
            // Fingers - left
            "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
            "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
            "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
            "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
            "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
            // Fingers - right
            "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
            "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
            "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
            "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
            "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
        };

        // Mapping from our bone names to Unity HumanBodyBones
        private static readonly Dictionary<string, HumanBodyBones> BoneNameToHumanBodyBone = new Dictionary<string, HumanBodyBones>(StringComparer.Ordinal)
        {
            { "hips", HumanBodyBones.Hips },
            { "spine", HumanBodyBones.Spine },
            { "chest", HumanBodyBones.Chest },
            { "upperChest", HumanBodyBones.UpperChest },
            { "neck", HumanBodyBones.Neck },
            { "head", HumanBodyBones.Head },
            { "leftShoulder", HumanBodyBones.LeftShoulder },
            { "leftUpperArm", HumanBodyBones.LeftUpperArm },
            { "leftLowerArm", HumanBodyBones.LeftLowerArm },
            { "leftHand", HumanBodyBones.LeftHand },
            { "rightShoulder", HumanBodyBones.RightShoulder },
            { "rightUpperArm", HumanBodyBones.RightUpperArm },
            { "rightLowerArm", HumanBodyBones.RightLowerArm },
            { "rightHand", HumanBodyBones.RightHand },
            { "leftUpperLeg", HumanBodyBones.LeftUpperLeg },
            { "leftLowerLeg", HumanBodyBones.LeftLowerLeg },
            { "leftFoot", HumanBodyBones.LeftFoot },
            { "leftToes", HumanBodyBones.LeftToes },
            { "rightUpperLeg", HumanBodyBones.RightUpperLeg },
            { "rightLowerLeg", HumanBodyBones.RightLowerLeg },
            { "rightFoot", HumanBodyBones.RightFoot },
            { "rightToes", HumanBodyBones.RightToes },
            // Fingers left
            { "leftThumbMetacarpal", HumanBodyBones.LeftThumbProximal },
            { "leftThumbProximal", HumanBodyBones.LeftThumbIntermediate },
            { "leftThumbDistal", HumanBodyBones.LeftThumbDistal },
            { "leftIndexProximal", HumanBodyBones.LeftIndexProximal },
            { "leftIndexIntermediate", HumanBodyBones.LeftIndexIntermediate },
            { "leftIndexDistal", HumanBodyBones.LeftIndexDistal },
            { "leftMiddleProximal", HumanBodyBones.LeftMiddleProximal },
            { "leftMiddleIntermediate", HumanBodyBones.LeftMiddleIntermediate },
            { "leftMiddleDistal", HumanBodyBones.LeftMiddleDistal },
            { "leftRingProximal", HumanBodyBones.LeftRingProximal },
            { "leftRingIntermediate", HumanBodyBones.LeftRingIntermediate },
            { "leftRingDistal", HumanBodyBones.LeftRingDistal },
            { "leftLittleProximal", HumanBodyBones.LeftLittleProximal },
            { "leftLittleIntermediate", HumanBodyBones.LeftLittleIntermediate },
            { "leftLittleDistal", HumanBodyBones.LeftLittleDistal },
            // Fingers right
            { "rightThumbMetacarpal", HumanBodyBones.RightThumbProximal },
            { "rightThumbProximal", HumanBodyBones.RightThumbIntermediate },
            { "rightThumbDistal", HumanBodyBones.RightThumbDistal },
            { "rightIndexProximal", HumanBodyBones.RightIndexProximal },
            { "rightIndexIntermediate", HumanBodyBones.RightIndexIntermediate },
            { "rightIndexDistal", HumanBodyBones.RightIndexDistal },
            { "rightMiddleProximal", HumanBodyBones.RightMiddleProximal },
            { "rightMiddleIntermediate", HumanBodyBones.RightMiddleIntermediate },
            { "rightMiddleDistal", HumanBodyBones.RightMiddleDistal },
            { "rightRingProximal", HumanBodyBones.RightRingProximal },
            { "rightRingIntermediate", HumanBodyBones.RightRingIntermediate },
            { "rightRingDistal", HumanBodyBones.RightRingDistal },
            { "rightLittleProximal", HumanBodyBones.RightLittleProximal },
            { "rightLittleIntermediate", HumanBodyBones.RightLittleIntermediate },
            { "rightLittleDistal", HumanBodyBones.RightLittleDistal },
        };

        // Parent index for each bone (-1 = root)
        private static readonly int[] ParentIndices =
        {
            -1, // hips (root)
            0,  // spine -> hips
            1,  // chest -> spine
            2,  // upperChest -> chest
            3,  // neck -> upperChest
            4,  // head -> neck
            3,  // leftShoulder -> upperChest
            6,  // leftUpperArm -> leftShoulder
            7,  // leftLowerArm -> leftUpperArm
            8,  // leftHand -> leftLowerArm
            3,  // rightShoulder -> upperChest
            10, // rightUpperArm -> rightShoulder
            11, // rightLowerArm -> rightUpperArm
            12, // rightHand -> rightLowerArm
            0,  // leftUpperLeg -> hips
            14, // leftLowerLeg -> leftUpperLeg
            15, // leftFoot -> leftLowerLeg
            16, // leftToes -> leftFoot
            0,  // rightUpperLeg -> hips
            18, // rightLowerLeg -> rightUpperLeg
            19, // rightFoot -> rightLowerLeg
            20, // rightToes -> rightFoot
            // Fingers left (parent = leftHand = 9)
            9, 22, 23,   // thumb: metacarpal, proximal, distal
            9, 25, 26,   // index: proximal, intermediate, distal
            9, 28, 29,   // middle: proximal, intermediate, distal
            9, 31, 32,   // ring: proximal, intermediate, distal
            9, 34, 35,   // little: proximal, intermediate, distal
            // Fingers right (parent = rightHand = 13)
            13, 37, 38,  // thumb: metacarpal, proximal, distal
            13, 40, 41,  // index: proximal, intermediate, distal
            13, 43, 44,  // middle: proximal, intermediate, distal
            13, 46, 47,  // ring: proximal, intermediate, distal
            13, 49, 50,  // little: proximal, intermediate, distal
        };

        public static void RunFromCommandLine()
        {
            var args = ParseArguments(Environment.GetCommandLineArgs());

            var semanticId = RequireArgument(args, "semantic-id");
            var repoRoot = RequireArgument(args, "repo-root");
            var sourceAssetPath = RequireArgument(args, "source-asset-path");
            var vrmaOutput = RequireArgument(args, "vrma-output");

            AssetDatabase.Refresh();

            // Ensure the FBX is imported as Humanoid so we get a valid Avatar
            var importer = AssetImporter.GetAtPath(sourceAssetPath) as ModelImporter;
            if (importer != null && importer.animationType != ModelImporterAnimationType.Human)
            {
                importer.animationType = ModelImporterAnimationType.Human;
                importer.SaveAndReimport();
                AssetDatabase.Refresh();
            }

            var clip = LoadAnimationClip(sourceAssetPath);
            if (clip == null)
            {
                throw new InvalidOperationException($"Unable to load AnimationClip at asset path '{sourceAssetPath}'.");
            }

            // Export bone local rotations (same approach as the working v2 pipeline).
            // With identity VRMA rests, retargeting is pass-through. The library's VRM 0.x
            // compensation converts the track to the correct normalized bone value.
            ExportClipAsVrma(clip, semanticId, vrmaOutput);

            Debug.Log($"[VrmaExporter] Exported '{semanticId}' to '{vrmaOutput}'");
            EditorApplication.Exit(0);
        }

        private static AnimationClip LoadAnimationClip(string assetPath)
        {
            var allAssets = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            foreach (var asset in allAssets)
            {
                if (asset is AnimationClip c && !c.name.Contains("__preview__"))
                {
                    return c;
                }
            }
            return null;
        }

        /// <summary>
        /// Export using the FBX model's own Avatar via HumanPoseHandler.
        /// This uses the FBX skeleton's real bone axes for muscle→rotation conversion,
        /// and captures the source skeleton's REAL rest-pose rotations in the VRMA nodes.
        /// three-vrm's createVRMAnimationClip then computes:
        ///   delta = track * inverse(sourceRest)
        ///   result = vrmRest * delta
        /// which properly retargets the animation to any VRM model.
        /// </summary>
        public static void ExportFbxClipAsVrma(AnimationClip clip, string sourceAssetPath, string semanticId, string outputPath)
        {
            var allAssets = AssetDatabase.LoadAllAssetsAtPath(sourceAssetPath);
            Avatar fbxAvatar = null;
            GameObject fbxModelPrefab = null;

            foreach (var asset in allAssets)
            {
                if (asset is Avatar a && a.isValid && a.isHuman)
                    fbxAvatar = a;
                if (asset is GameObject go && go.transform.parent == null)
                {
                    if (fbxModelPrefab == null)
                        fbxModelPrefab = go;
                }
            }

            if (fbxAvatar == null || fbxModelPrefab == null)
            {
                Debug.LogWarning($"[VrmaExporter] No humanoid Avatar in FBX '{sourceAssetPath}', falling back to synthetic-rig export.");
                ExportClipAsVrma(clip, semanticId, outputPath);
                return;
            }

            // Instantiate the FBX model so we have its real skeleton hierarchy
            var instance = UnityEngine.Object.Instantiate(fbxModelPrefab);
            instance.hideFlags = HideFlags.HideAndDontSave;
            HumanPoseHandler poseHandler = null;

            try
            {
                var animator = instance.GetComponent<Animator>();
                if (animator == null)
                    animator = instance.AddComponent<Animator>();
                animator.avatar = fbxAvatar;
                animator.applyRootMotion = false;
                animator.Rebind();
                animator.Update(0f);

                poseHandler = new HumanPoseHandler(fbxAvatar, instance.transform);

                var durationSeconds = Mathf.Max(0f, clip.length);
                var sampleCount = Mathf.Max(2, Mathf.RoundToInt(durationSeconds * FrameRate) + 1);
                var times = new float[sampleCount];
                for (var i = 0; i < sampleCount; i++)
                    times[i] = i < sampleCount - 1 ? i / (float)FrameRate : durationSeconds;

                var boneCount = HumanoidBoneNames.Length;

                // Extract muscle curves from the clip.
                // For FBX Humanoid clips, property names are direct muscle names like
                // "Left Upper Leg Front-Back" (no "Muscle" prefix). Accept all curves
                // bound to the Animator on the root path (these are muscle/root-motion curves).
                var muscleValues = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase);
                var bindings = AnimationUtility.GetCurveBindings(clip);
                foreach (var binding in bindings)
                {
                    var prop = binding.propertyName;
                    // Skip transform curves (position/rotation/scale on specific paths)
                    if (!string.IsNullOrEmpty(binding.path))
                        continue;

                    var curve = AnimationUtility.GetEditorCurve(clip, binding);
                    if (curve == null) continue;

                    var samples = new float[sampleCount];
                    for (var i = 0; i < sampleCount; i++)
                        samples[i] = curve.Evaluate(times[i]);

                    muscleValues[NormalizeMusclePropertyName(prop)] = samples;
                }

                // Build muscle name → index map
                var muscleNameToIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                for (var i = 0; i < HumanTrait.MuscleCount; i++)
                {
                    muscleNameToIndex[NormalizeMusclePropertyName(HumanTrait.MuscleName[i])] = i;
                }

                // Sample each frame using HumanPoseHandler on the FBX skeleton
                var boneRotations = new Quaternion[boneCount][];
                var hipsTranslations = new Vector3[sampleCount];
                for (var b = 0; b < boneCount; b++)
                    boneRotations[b] = new Quaternion[sampleCount];

                var humanPose = new HumanPose();

                // Pre-extract root motion curves (may or may not exist)
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootT.x"), out var rootTxSamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootT.y"), out var rootTySamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootT.z"), out var rootTzSamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootQ.x"), out var rootQxSamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootQ.y"), out var rootQySamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootQ.z"), out var rootQzSamples);
                muscleValues.TryGetValue(NormalizeMusclePropertyName("RootQ.w"), out var rootQwSamples);

                // Initialize humanPose struct once
                poseHandler.GetHumanPose(ref humanPose);

                for (var frame = 0; frame < sampleCount; frame++)
                {
                    // Zero all muscles then set from curves
                    for (var m = 0; m < humanPose.muscles.Length && m < HumanTrait.MuscleCount; m++)
                        humanPose.muscles[m] = 0f;

                    foreach (var kvp in muscleValues)
                    {
                        if (muscleNameToIndex.TryGetValue(kvp.Key, out var muscleIdx))
                        {
                            humanPose.muscles[muscleIdx] = kvp.Value[frame];
                        }
                    }

                    // ALWAYS set body position/rotation to ensure consistency with rest pose.
                    // Default to identity/neutral when no root motion curves exist.
                    humanPose.bodyPosition = new Vector3(
                        rootTxSamples != null ? rootTxSamples[frame] : 0f,
                        rootTySamples != null ? rootTySamples[frame] : 1f,
                        rootTzSamples != null ? rootTzSamples[frame] : 0f);
                    humanPose.bodyRotation = new Quaternion(
                        rootQxSamples != null ? rootQxSamples[frame] : 0f,
                        rootQySamples != null ? rootQySamples[frame] : 0f,
                        rootQzSamples != null ? rootQzSamples[frame] : 0f,
                        rootQwSamples != null ? rootQwSamples[frame] : 1f);

                    poseHandler.SetHumanPose(ref humanPose);

                    // Read bone rotations from the FBX skeleton
                    for (var b = 0; b < boneCount; b++)
                    {
                        if (!BoneNameToHumanBodyBone.TryGetValue(HumanoidBoneNames[b], out var hbb))
                        {
                            boneRotations[b][frame] = Quaternion.identity;
                            continue;
                        }
                        var bt = animator.GetBoneTransform(hbb);
                        boneRotations[b][frame] = bt != null ? bt.localRotation : Quaternion.identity;

                        if (hbb == HumanBodyBones.Hips && bt != null)
                            hipsTranslations[frame] = bt.localPosition;
                    }
                }

                // Capture REST pose (all muscles zeroed) — these become the VRMA node rotations
                var restRotations = new Quaternion[boneCount];
                var restHipsY = 1f;

                for (var m = 0; m < humanPose.muscles.Length; m++)
                    humanPose.muscles[m] = 0f;
                // Reset body to default T-pose position
                humanPose.bodyPosition = new Vector3(0f, 1f, 0f);
                humanPose.bodyRotation = Quaternion.identity;
                poseHandler.SetHumanPose(ref humanPose);

                for (var b = 0; b < boneCount; b++)
                {
                    if (!BoneNameToHumanBodyBone.TryGetValue(HumanoidBoneNames[b], out var hbb))
                    {
                        restRotations[b] = Quaternion.identity;
                        continue;
                    }
                    var bt = animator.GetBoneTransform(hbb);
                    restRotations[b] = bt != null ? bt.localRotation : Quaternion.identity;
                    if (hbb == HumanBodyBones.Hips && bt != null)
                        restHipsY = bt.position.y;
                }

                var clipSettings = AnimationUtility.GetAnimationClipSettings(clip);
                WriteGlb(outputPath, semanticId, times, boneRotations, hipsTranslations, restRotations, restHipsY,
                    clipSettings.loopTime || semanticId.StartsWith("idle.", StringComparison.Ordinal) || semanticId.EndsWith(".loop", StringComparison.Ordinal));
            }
            finally
            {
                if (poseHandler != null) poseHandler.Dispose();
                UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        public static void ExportClipAsVrma(AnimationClip clip, string semanticId, string outputPath)
        {
            var clipSettings = AnimationUtility.GetAnimationClipSettings(clip);
            var durationSeconds = Mathf.Max(0f, clip.length);
            var sampleCount = Mathf.Max(2, Mathf.RoundToInt(durationSeconds * FrameRate) + 1);

            // Build sample times at 30fps
            var times = new float[sampleCount];
            for (var i = 0; i < sampleCount; i++)
            {
                times[i] = i < sampleCount - 1 ? i / (float)FrameRate : durationSeconds;
            }

            // Extract muscle curves from the clip
            var bindings = AnimationUtility.GetCurveBindings(clip);
            var muscleValues = new Dictionary<string, float[]>(StringComparer.Ordinal);
            float[] rootTx = null, rootTy = null, rootTz = null;
            float[] rootQx = null, rootQy = null, rootQz = null, rootQw = null;

            foreach (var binding in bindings)
            {
                var curve = AnimationUtility.GetEditorCurve(clip, binding);
                if (curve == null) continue;

                var samples = new float[sampleCount];
                for (var i = 0; i < sampleCount; i++)
                {
                    samples[i] = curve.Evaluate(times[i]);
                }

                var prop = binding.propertyName;
                if (prop == "RootT.x") rootTx = samples;
                else if (prop == "RootT.y") rootTy = samples;
                else if (prop == "RootT.z") rootTz = samples;
                else if (prop == "RootQ.x") rootQx = samples;
                else if (prop == "RootQ.y") rootQy = samples;
                else if (prop == "RootQ.z") rootQz = samples;
                else if (prop == "RootQ.w") rootQw = samples;
                else
                {
                    // Store muscle channel by normalized name for lookup
                    muscleValues[NormalizeMusclePropertyName(prop)] = samples;
                }
            }

            // Build the humanoid rig and sample bone rotations per frame
            var rig = CreateExportRig();
            try
            {
                var boneCount = HumanoidBoneNames.Length;
                var boneRotations = new Quaternion[boneCount][];
                var hipsTranslations = new Vector3[sampleCount];

                // Get rest-pose hips height for the rig
                var restHipsY = rig.animator.GetBoneTransform(HumanBodyBones.Hips).position.y;

                for (var b = 0; b < boneCount; b++)
                {
                    boneRotations[b] = new Quaternion[sampleCount];
                }

                // Build muscle index lookup
                var muscleNameToIndex = new Dictionary<string, int>(StringComparer.Ordinal);
                for (var i = 0; i < HumanTrait.MuscleCount; i++)
                {
                    muscleNameToIndex[NormalizeMusclePropertyName(HumanTrait.MuscleName[i])] = i;
                }

                var pose = new HumanPose();
                pose.bodyPosition = new Vector3(0f, restHipsY, 0f);
                pose.bodyRotation = Quaternion.identity;
                pose.muscles = new float[HumanTrait.MuscleCount];

                for (var frame = 0; frame < sampleCount; frame++)
                {
                    // Set pose for this frame
                    pose.bodyPosition = new Vector3(
                        rootTx != null ? rootTx[frame] : 0f,
                        rootTy != null ? rootTy[frame] : restHipsY,
                        rootTz != null ? rootTz[frame] : 0f);
                    pose.bodyRotation = new Quaternion(
                        rootQx != null ? rootQx[frame] : 0f,
                        rootQy != null ? rootQy[frame] : 0f,
                        rootQz != null ? rootQz[frame] : 0f,
                        rootQw != null ? rootQw[frame] : 1f);

                    Array.Clear(pose.muscles, 0, pose.muscles.Length);

                    // Fill muscle values
                    foreach (var kvp in muscleValues)
                    {
                        if (muscleNameToIndex.TryGetValue(kvp.Key, out var muscleIdx))
                        {
                            pose.muscles[muscleIdx] = kvp.Value[frame];
                        }
                    }

                    rig.poseHandler.SetHumanPose(ref pose);

                    // Sample bone LOCAL rotations directly from HumanPoseHandler output.
                    // Unity's normalized humanoid local rotations are compatible with
                    // VRM 0.x normalized bones when applied directly — this is exactly
                    // what the working v2 pipeline does (RawAnimBatchExporter).
                    // Skip finger bones (indices >= 22) — v2 doesn't animate them,
                    // and the Mixamo idle finger data creates unnatural poses on VRM models.
                    for (var b = 0; b < boneCount; b++)
                    {
                        if (b >= 22)
                        {
                            boneRotations[b][frame] = Quaternion.identity;
                            continue;
                        }

                        if (!BoneNameToHumanBodyBone.TryGetValue(HumanoidBoneNames[b], out var hbb))
                            continue;

                        var boneTransform = rig.animator.GetBoneTransform(hbb);
                        boneRotations[b][frame] = boneTransform != null ? boneTransform.localRotation : Quaternion.identity;
                    }

                    // Sample hips world position for translation track
                    var hipsTransform = rig.animator.GetBoneTransform(HumanBodyBones.Hips);
                    hipsTranslations[frame] = hipsTransform != null ? hipsTransform.localPosition : Vector3.zero;
                }

                // Lock hips X/Z to prevent horizontal sliding.
                // V2's mixer playback uses constant rest XZ with only Y varying (FK-computed).
                // For VRMA, zeroing X/Z achieves the same effect: the model stays planted.
                for (var frame = 0; frame < sampleCount; frame++)
                {
                    hipsTranslations[frame] = new Vector3(0f, hipsTranslations[frame].y, 0f);
                }

                // Pre-transform rotations so that after WriteGlb's (-x,-y,z,w) conversion
                // and the library's VRM 0.x compensation (-x,y,-z,w), the normalized bone
                // receives (-x,-y,z,w) of the original Unity localRotation — matching v2's
                // interleaveQuaternionSamples which applies the same LH→RH transform.
                // Chain: (-x,y,-z,w) → WriteGlb → (x,-y,-z,w) → VRM0.x comp → (-x,-y,z,w) ✓
                for (var b = 0; b < boneCount; b++)
                {
                    for (var frame = 0; frame < sampleCount; frame++)
                    {
                        var q = boneRotations[b][frame];
                        boneRotations[b][frame] = new Quaternion(-q.x, q.y, -q.z, q.w);
                    }
                }

                // Write with identity rest rotations — retargeting becomes pass-through.
                var identityRests = new Quaternion[boneCount];
                for (var b = 0; b < boneCount; b++)
                {
                    identityRests[b] = Quaternion.identity;
                }

                WriteGlb(outputPath, semanticId, times, boneRotations, hipsTranslations, identityRests, restHipsY,
                    clipSettings.loopTime || semanticId.StartsWith("idle.", StringComparison.Ordinal) || semanticId.EndsWith(".loop", StringComparison.Ordinal));
            }
            finally
            {
                if (rig.poseHandler != null) rig.poseHandler.Dispose();
                if (rig.avatar != null) UnityEngine.Object.DestroyImmediate(rig.avatar);
                if (rig.root != null) UnityEngine.Object.DestroyImmediate(rig.root);
            }
        }

        private static void WriteGlb(string outputPath, string semanticId, float[] times,
            Quaternion[][] boneRotations, Vector3[] hipsTranslations, Quaternion[] restRotations,
            float restHipsY, bool isLoop)
        {
            var boneCount = HumanoidBoneNames.Length;
            var frameCount = times.Length;

            // === Build binary buffer ===
            // Layout:
            //   [times float32 array] (shared for all channels)
            //   [hips translation vec3 array]
            //   [per-bone rotation quaternion arrays]

            var timesBytes = frameCount * 4;
            var hipsTransBytes = frameCount * 12; // vec3
            var rotBytes = frameCount * 16; // vec4 per bone

            var totalBufferSize = timesBytes + hipsTransBytes + (boneCount * rotBytes);
            var buffer = new byte[totalBufferSize];
            var offset = 0;

            // Write times
            var timesOffset = offset;
            for (var i = 0; i < frameCount; i++)
            {
                WriteFloat(buffer, offset, times[i]);
                offset += 4;
            }

            // Write hips translations (convert to glTF right-handed: x, y, -z)
            var hipsTransOffset = offset;
            for (var i = 0; i < frameCount; i++)
            {
                WriteFloat(buffer, offset, hipsTranslations[i].x);
                offset += 4;
                WriteFloat(buffer, offset, hipsTranslations[i].y);
                offset += 4;
                WriteFloat(buffer, offset, -hipsTranslations[i].z); // negate Z for RH
                offset += 4;
            }

            // Write bone rotations (convert to glTF right-handed: -x, -y, z, w)
            var boneRotOffsets = new int[boneCount];
            for (var b = 0; b < boneCount; b++)
            {
                boneRotOffsets[b] = offset;
                for (var i = 0; i < frameCount; i++)
                {
                    var q = boneRotations[b][i];
                    // Unity LH → glTF RH: negate X and Y (Z-axis flip reverses X/Y rotation sense)
                    WriteFloat(buffer, offset, -q.x);
                    offset += 4;
                    WriteFloat(buffer, offset, -q.y);
                    offset += 4;
                    WriteFloat(buffer, offset, q.z);
                    offset += 4;
                    WriteFloat(buffer, offset, q.w);
                    offset += 4;
                }
            }

            // === Build glTF JSON ===
            var json = new GltfDocument();

            // Asset
            json.asset = new GltfAsset { version = "2.0", generator = "NikoF VrmaExporter" };

            // Extensions used
            json.extensionsUsed = new[] { "VRMC_vrm_animation" };

            // Scene
            json.scene = 0;
            json.scenes = new[] { new GltfScene { nodes = new[] { 0 } } }; // root node

            // Nodes - build hierarchy
            // Node 0 = virtual root (not a bone), children = [hips index + 1]
            // Actual bone nodes start at index 1
            var nodeList = new List<GltfNode>();

            // Virtual root node
            var rootChildren = new List<int>();
            // Find bones whose parent is -1 (root-level = hips)
            for (var b = 0; b < boneCount; b++)
            {
                if (ParentIndices[b] == -1)
                    rootChildren.Add(b + 1); // +1 for virtual root offset
            }
            nodeList.Add(new GltfNode
            {
                name = "VrmaRoot",
                children = rootChildren.ToArray(),
            });

            // Bone nodes
            for (var b = 0; b < boneCount; b++)
            {
                var children = new List<int>();
                for (var c = 0; c < boneCount; c++)
                {
                    if (ParentIndices[c] == b)
                        children.Add(c + 1); // +1 for virtual root offset
                }

                var restRot = restRotations[b];
                // Convert rest rotation to glTF RH: negate X and Y (Z-axis flip)
                var node = new GltfNode
                {
                    name = HumanoidBoneNames[b],
                    rotation = new[] { -restRot.x, -restRot.y, restRot.z, restRot.w },
                };
                // Hips node needs rest translation so three-vrm-animation can properly
                // retarget the position track (avoids division by zero on Y)
                if (b == 0)
                {
                    node.translation = new[] { 0f, restHipsY, 0f };
                }
                if (children.Count > 0)
                    node.children = children.ToArray();

                nodeList.Add(node);
            }

            json.nodes = nodeList.ToArray();

            // Buffer
            json.buffers = new[] { new GltfBuffer { byteLength = totalBufferSize } };

            // Buffer views
            var bufferViews = new List<GltfBufferView>();

            // BV 0: times
            bufferViews.Add(new GltfBufferView { buffer = 0, byteOffset = timesOffset, byteLength = timesBytes });
            // BV 1: hips translations
            bufferViews.Add(new GltfBufferView { buffer = 0, byteOffset = hipsTransOffset, byteLength = hipsTransBytes });
            // BV 2+: per-bone rotations
            for (var b = 0; b < boneCount; b++)
            {
                bufferViews.Add(new GltfBufferView { buffer = 0, byteOffset = boneRotOffsets[b], byteLength = rotBytes });
            }

            json.bufferViews = bufferViews.ToArray();

            // Accessors
            var accessors = new List<GltfAccessor>();
            var timeMin = times[0];
            var timeMax = times[frameCount - 1];

            // Accessor 0: times (shared)
            accessors.Add(new GltfAccessor
            {
                bufferView = 0,
                componentType = 5126, // FLOAT
                count = frameCount,
                type = "SCALAR",
                min = new[] { timeMin },
                max = new[] { timeMax },
            });

            // Accessor 1: hips translations
            accessors.Add(new GltfAccessor
            {
                bufferView = 1,
                componentType = 5126,
                count = frameCount,
                type = "VEC3",
            });

            // Accessors 2+: bone rotations
            for (var b = 0; b < boneCount; b++)
            {
                accessors.Add(new GltfAccessor
                {
                    bufferView = 2 + b,
                    componentType = 5126,
                    count = frameCount,
                    type = "VEC4",
                });
            }

            json.accessors = accessors.ToArray();

            // Animation
            var channels = new List<GltfAnimationChannel>();
            var samplers = new List<GltfAnimationSampler>();
            var samplerIndex = 0;

            // Hips translation channel
            samplers.Add(new GltfAnimationSampler { input = 0, output = 1, interpolation = "LINEAR" });
            channels.Add(new GltfAnimationChannel
            {
                sampler = samplerIndex,
                target = new GltfAnimationChannelTarget { node = 1, path = "translation" } // node 1 = hips (index 0 + 1 for root)
            });
            samplerIndex++;

            // Rotation channels for all bones
            for (var b = 0; b < boneCount; b++)
            {
                samplers.Add(new GltfAnimationSampler { input = 0, output = 2 + b, interpolation = "LINEAR" });
                channels.Add(new GltfAnimationChannel
                {
                    sampler = samplerIndex,
                    target = new GltfAnimationChannelTarget { node = b + 1, path = "rotation" } // +1 for root offset
                });
                samplerIndex++;
            }

            json.animations = new[]
            {
                new GltfAnimation
                {
                    name = semanticId,
                    channels = channels.ToArray(),
                    samplers = samplers.ToArray(),
                }
            };

            // VRMC_vrm_animation extension
            var humanBones = new Dictionary<string, object>();
            for (var b = 0; b < boneCount; b++)
            {
                humanBones[HumanoidBoneNames[b]] = new { node = b + 1 }; // +1 for virtual root
            }

            json.extensions = new Dictionary<string, object>
            {
                ["VRMC_vrm_animation"] = new Dictionary<string, object>
                {
                    ["specVersion"] = "1.0",
                    ["humanoid"] = new Dictionary<string, object>
                    {
                        ["humanBones"] = humanBones,
                    },
                }
            };

            // Serialize JSON
            var jsonString = SerializeGltfJson(json);

            // Write GLB
            WriteGlbFile(outputPath, jsonString, buffer);
        }

        private static void WriteGlbFile(string outputPath, string jsonString, byte[] binaryBuffer)
        {
            // Pad JSON to 4-byte alignment
            var jsonBytes = Encoding.UTF8.GetBytes(jsonString);
            var jsonPadding = (4 - (jsonBytes.Length % 4)) % 4;
            var jsonChunkLength = jsonBytes.Length + jsonPadding;

            // Pad binary to 4-byte alignment
            var binPadding = (4 - (binaryBuffer.Length % 4)) % 4;
            var binChunkLength = binaryBuffer.Length + binPadding;

            // GLB structure: 12-byte header + JSON chunk (8+data) + BIN chunk (8+data)
            var totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;

            var dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrWhiteSpace(dir))
                Directory.CreateDirectory(dir);

            using (var stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            using (var writer = new BinaryWriter(stream))
            {
                // GLB Header
                writer.Write(0x46546C67); // magic: "glTF"
                writer.Write((uint)2);     // version
                writer.Write((uint)totalLength);

                // JSON chunk
                writer.Write((uint)jsonChunkLength);
                writer.Write(0x4E4F534A); // "JSON"
                writer.Write(jsonBytes);
                for (var i = 0; i < jsonPadding; i++)
                    writer.Write((byte)0x20); // space padding for JSON

                // BIN chunk
                writer.Write((uint)binChunkLength);
                writer.Write(0x004E4942); // "BIN\0"
                writer.Write(binaryBuffer);
                for (var i = 0; i < binPadding; i++)
                    writer.Write((byte)0x00); // zero padding for binary
            }
        }

        private static string SerializeGltfJson(GltfDocument doc)
        {
            // Manual JSON serialization since Unity's JsonUtility doesn't handle
            // Dictionary<string, object> or nested anonymous types well.
            var sb = new StringBuilder(8192);
            sb.Append('{');

            // asset
            sb.Append("\"asset\":{\"version\":\"2.0\",\"generator\":\"NikoF VrmaExporter\"}");

            // extensionsUsed
            sb.Append(",\"extensionsUsed\":[\"VRMC_vrm_animation\"]");

            // scene
            sb.Append(",\"scene\":0");

            // scenes
            sb.Append(",\"scenes\":[{\"nodes\":[0]}]");

            // nodes
            sb.Append(",\"nodes\":[");
            for (var i = 0; i < doc.nodes.Length; i++)
            {
                if (i > 0) sb.Append(',');
                SerializeNode(sb, doc.nodes[i]);
            }
            sb.Append(']');

            // buffers
            sb.AppendFormat(",\"buffers\":[{{\"byteLength\":{0}}}]", doc.buffers[0].byteLength);

            // bufferViews
            sb.Append(",\"bufferViews\":[");
            for (var i = 0; i < doc.bufferViews.Length; i++)
            {
                if (i > 0) sb.Append(',');
                var bv = doc.bufferViews[i];
                sb.AppendFormat("{{\"buffer\":{0},\"byteOffset\":{1},\"byteLength\":{2}}}",
                    bv.buffer, bv.byteOffset, bv.byteLength);
            }
            sb.Append(']');

            // accessors
            sb.Append(",\"accessors\":[");
            for (var i = 0; i < doc.accessors.Length; i++)
            {
                if (i > 0) sb.Append(',');
                var acc = doc.accessors[i];
                sb.AppendFormat("{{\"bufferView\":{0},\"componentType\":{1},\"count\":{2},\"type\":\"{3}\"",
                    acc.bufferView, acc.componentType, acc.count, acc.type);
                if (acc.min != null)
                    sb.AppendFormat(",\"min\":[{0}]", FormatFloat(acc.min[0]));
                if (acc.max != null)
                    sb.AppendFormat(",\"max\":[{0}]", FormatFloat(acc.max[0]));
                sb.Append('}');
            }
            sb.Append(']');

            // animations
            sb.Append(",\"animations\":[");
            for (var a = 0; a < doc.animations.Length; a++)
            {
                if (a > 0) sb.Append(',');
                var anim = doc.animations[a];
                sb.AppendFormat("{{\"name\":\"{0}\",\"channels\":[", EscapeJsonString(anim.name));
                for (var c = 0; c < anim.channels.Length; c++)
                {
                    if (c > 0) sb.Append(',');
                    var ch = anim.channels[c];
                    sb.AppendFormat("{{\"sampler\":{0},\"target\":{{\"node\":{1},\"path\":\"{2}\"}}}}",
                        ch.sampler, ch.target.node, ch.target.path);
                }
                sb.Append("],\"samplers\":[");
                for (var s = 0; s < anim.samplers.Length; s++)
                {
                    if (s > 0) sb.Append(',');
                    var smp = anim.samplers[s];
                    sb.AppendFormat("{{\"input\":{0},\"output\":{1},\"interpolation\":\"{2}\"}}",
                        smp.input, smp.output, smp.interpolation);
                }
                sb.Append("]}");
            }
            sb.Append(']');

            // extensions (VRMC_vrm_animation)
            sb.Append(",\"extensions\":{\"VRMC_vrm_animation\":{\"specVersion\":\"1.0\",\"humanoid\":{\"humanBones\":{");
            var boneEntries = (Dictionary<string, object>)((Dictionary<string, object>)((Dictionary<string, object>)doc.extensions["VRMC_vrm_animation"])["humanoid"])["humanBones"];
            var first = true;
            foreach (var kvp in boneEntries)
            {
                if (!first) sb.Append(',');
                first = false;
                // Get node index from anonymous type via reflection
                var nodeValue = kvp.Value.GetType().GetProperty("node").GetValue(kvp.Value);
                sb.AppendFormat("\"{0}\":{{\"node\":{1}}}", kvp.Key, nodeValue);
            }
            sb.Append("}}}}");

            sb.Append('}');
            return sb.ToString();
        }

        private static void SerializeNode(StringBuilder sb, GltfNode node)
        {
            sb.Append('{');
            sb.AppendFormat("\"name\":\"{0}\"", EscapeJsonString(node.name));
            if (node.children != null && node.children.Length > 0)
            {
                sb.Append(",\"children\":[");
                for (var i = 0; i < node.children.Length; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(node.children[i]);
                }
                sb.Append(']');
            }
            if (node.rotation != null)
            {
                sb.AppendFormat(",\"rotation\":[{0},{1},{2},{3}]",
                    FormatFloat(node.rotation[0]),
                    FormatFloat(node.rotation[1]),
                    FormatFloat(node.rotation[2]),
                    FormatFloat(node.rotation[3]));
            }
            if (node.translation != null)
            {
                sb.AppendFormat(",\"translation\":[{0},{1},{2}]",
                    FormatFloat(node.translation[0]),
                    FormatFloat(node.translation[1]),
                    FormatFloat(node.translation[2]));
            }
            sb.Append('}');
        }

        private static string FormatFloat(float value)
        {
            return value.ToString("G9", CultureInfo.InvariantCulture);
        }

        private static string EscapeJsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void WriteFloat(byte[] buffer, int offset, float value)
        {
            var bytes = BitConverter.GetBytes(value);
            buffer[offset] = bytes[0];
            buffer[offset + 1] = bytes[1];
            buffer[offset + 2] = bytes[2];
            buffer[offset + 3] = bytes[3];
        }

        private static ExportRig CreateExportRig()
        {
            var root = new GameObject("VrmaExportRig") { hideFlags = HideFlags.HideAndDontSave };

            // Build skeleton matching the v2 pipeline's rig (RawAnimBatchExporter.CreatePunchComparisonRig).
            // The rest rotations and Z-offsets affect how AvatarBuilder constructs bone axes,
            // which determines the muscle→localRotation mapping. Using the same rig ensures
            // v3 VRMA produces identical normalized bone values as v2.
            var hips = CreateBone(root.transform, "Hips", new Vector3(0f, 1f, 0f), Quaternion.Euler(4f, 0f, 0f));
            var spine = CreateBone(hips, "Spine", new Vector3(0f, 0.12f, -0.01f), Quaternion.Euler(3f, 0f, 0f));
            var chest = CreateBone(spine, "Chest", new Vector3(0f, 0.14f, -0.005f), Quaternion.Euler(2.5f, 0f, 0f));
            var upperChest = CreateBone(chest, "UpperChest", new Vector3(0f, 0.12f, 0.01f), Quaternion.Euler(1.5f, 0f, 0f));
            var neck = CreateBone(upperChest, "Neck", new Vector3(0f, 0.12f, 0f), Quaternion.Euler(3f, 0f, 0f));
            CreateBone(neck, "Head", new Vector3(0f, 0.12f, 0f), Quaternion.Euler(-2f, 0f, 0f));

            var leftShoulder = CreateBone(upperChest, "LeftShoulder", new Vector3(-0.07f, 0.1f, 0f), Quaternion.Euler(0f, 0f, 3f));
            var leftUpperArm = CreateBone(leftShoulder, "LeftUpperArm", new Vector3(-0.18f, 0f, 0f));
            var leftLowerArm = CreateBone(leftUpperArm, "LeftLowerArm", new Vector3(-0.28f, 0f, 0f));
            var leftHand = CreateBone(leftLowerArm, "LeftHand", new Vector3(-0.22f, 0f, 0f));

            var rightShoulder = CreateBone(upperChest, "RightShoulder", new Vector3(0.07f, 0.1f, 0f), Quaternion.Euler(0f, 0f, -3f));
            var rightUpperArm = CreateBone(rightShoulder, "RightUpperArm", new Vector3(0.18f, 0f, 0f));
            var rightLowerArm = CreateBone(rightUpperArm, "RightLowerArm", new Vector3(0.28f, 0f, 0f));
            var rightHand = CreateBone(rightLowerArm, "RightHand", new Vector3(0.22f, 0f, 0f));

            var leftUpperLeg = CreateBone(hips, "LeftUpperLeg", new Vector3(-0.09f, -0.12f, 0f));
            var leftLowerLeg = CreateBone(leftUpperLeg, "LeftLowerLeg", new Vector3(0f, -0.46f, 0f));
            var leftFoot = CreateBone(leftLowerLeg, "LeftFoot", new Vector3(0f, -0.44f, 0.08f));
            CreateBone(leftFoot, "LeftToes", new Vector3(0f, 0f, 0.14f));

            var rightUpperLeg = CreateBone(hips, "RightUpperLeg", new Vector3(0.09f, -0.12f, 0f));
            var rightLowerLeg = CreateBone(rightUpperLeg, "RightLowerLeg", new Vector3(0f, -0.46f, 0f));
            var rightFoot = CreateBone(rightLowerLeg, "RightFoot", new Vector3(0f, -0.44f, 0.08f));
            CreateBone(rightFoot, "RightToes", new Vector3(0f, 0f, 0.14f));

            // Fingers - left (thumbs need splay angle for valid avatar)
            var leftThumbMeta = CreateBone(leftHand, "LeftThumbMetacarpal", new Vector3(-0.02f, 0f, 0.02f), Quaternion.Euler(0f, 0f, -30f));
            var leftThumbProx = CreateBone(leftThumbMeta, "LeftThumbProximal", new Vector3(-0.04f, 0f, 0f));
            CreateBone(leftThumbProx, "LeftThumbDistal", new Vector3(-0.03f, 0f, 0f));

            var leftIndexProx = CreateBone(leftHand, "LeftIndexProximal", new Vector3(-0.08f, 0f, 0.015f));
            var leftIndexInter = CreateBone(leftIndexProx, "LeftIndexIntermediate", new Vector3(-0.04f, 0f, 0f));
            CreateBone(leftIndexInter, "LeftIndexDistal", new Vector3(-0.03f, 0f, 0f));

            var leftMiddleProx = CreateBone(leftHand, "LeftMiddleProximal", new Vector3(-0.08f, 0f, 0f));
            var leftMiddleInter = CreateBone(leftMiddleProx, "LeftMiddleIntermediate", new Vector3(-0.045f, 0f, 0f));
            CreateBone(leftMiddleInter, "LeftMiddleDistal", new Vector3(-0.03f, 0f, 0f));

            var leftRingProx = CreateBone(leftHand, "LeftRingProximal", new Vector3(-0.075f, 0f, -0.015f));
            var leftRingInter = CreateBone(leftRingProx, "LeftRingIntermediate", new Vector3(-0.04f, 0f, 0f));
            CreateBone(leftRingInter, "LeftRingDistal", new Vector3(-0.025f, 0f, 0f));

            var leftLittleProx = CreateBone(leftHand, "LeftLittleProximal", new Vector3(-0.07f, 0f, -0.03f));
            var leftLittleInter = CreateBone(leftLittleProx, "LeftLittleIntermediate", new Vector3(-0.03f, 0f, 0f));
            CreateBone(leftLittleInter, "LeftLittleDistal", new Vector3(-0.02f, 0f, 0f));

            // Fingers - right
            var rightThumbMeta = CreateBone(rightHand, "RightThumbMetacarpal", new Vector3(0.02f, 0f, 0.02f), Quaternion.Euler(0f, 0f, 30f));
            var rightThumbProx = CreateBone(rightThumbMeta, "RightThumbProximal", new Vector3(0.04f, 0f, 0f));
            CreateBone(rightThumbProx, "RightThumbDistal", new Vector3(0.03f, 0f, 0f));

            var rightIndexProx = CreateBone(rightHand, "RightIndexProximal", new Vector3(0.08f, 0f, 0.015f));
            var rightIndexInter = CreateBone(rightIndexProx, "RightIndexIntermediate", new Vector3(0.04f, 0f, 0f));
            CreateBone(rightIndexInter, "RightIndexDistal", new Vector3(0.03f, 0f, 0f));

            var rightMiddleProx = CreateBone(rightHand, "RightMiddleProximal", new Vector3(0.08f, 0f, 0f));
            var rightMiddleInter = CreateBone(rightMiddleProx, "RightMiddleIntermediate", new Vector3(0.045f, 0f, 0f));
            CreateBone(rightMiddleInter, "RightMiddleDistal", new Vector3(0.03f, 0f, 0f));

            var rightRingProx = CreateBone(rightHand, "RightRingProximal", new Vector3(0.075f, 0f, -0.015f));
            var rightRingInter = CreateBone(rightRingProx, "RightRingIntermediate", new Vector3(0.04f, 0f, 0f));
            CreateBone(rightRingInter, "RightRingDistal", new Vector3(0.025f, 0f, 0f));

            var rightLittleProx = CreateBone(rightHand, "RightLittleProximal", new Vector3(0.07f, 0f, -0.03f));
            var rightLittleInter = CreateBone(rightLittleProx, "RightLittleIntermediate", new Vector3(0.03f, 0f, 0f));
            CreateBone(rightLittleInter, "RightLittleDistal", new Vector3(0.02f, 0f, 0f));

            var animator = root.AddComponent<Animator>();
            var avatar = AvatarBuilder.BuildHumanAvatar(root, new HumanDescription
            {
                skeleton = BuildSkeletonBones(root.transform),
                human = BuildHumanBones(),
                armStretch = 0.05f,
                legStretch = 0.05f,
                upperArmTwist = 0.5f,
                lowerArmTwist = 0.5f,
                upperLegTwist = 0.5f,
                lowerLegTwist = 0.5f,
                feetSpacing = 0f,
                hasTranslationDoF = false,
            });

            if (avatar == null || !avatar.isValid || !avatar.isHuman)
            {
                throw new InvalidOperationException("Unable to build humanoid avatar for VRMA export rig.");
            }

            animator.avatar = avatar;
            animator.applyRootMotion = false;
            animator.Rebind();
            animator.Update(0f);

            return new ExportRig
            {
                root = root,
                avatar = avatar,
                animator = animator,
                poseHandler = new HumanPoseHandler(avatar, root.transform),
            };
        }

        private static Transform CreateBone(Transform parent, string boneName, Vector3 localPosition)
        {
            return CreateBone(parent, boneName, localPosition, Quaternion.identity);
        }

        private static Transform CreateBone(Transform parent, string boneName, Vector3 localPosition, Quaternion localRotation)
        {
            var bone = new GameObject(boneName) { hideFlags = HideFlags.HideAndDontSave }.transform;
            bone.SetParent(parent, false);
            bone.localPosition = localPosition;
            bone.localRotation = localRotation;
            bone.localScale = Vector3.one;
            return bone;
        }

        private static SkeletonBone[] BuildSkeletonBones(Transform root)
        {
            var bones = new List<SkeletonBone>();
            AddSkeletonBoneRecursive(root, bones);
            return bones.ToArray();
        }

        private static void AddSkeletonBoneRecursive(Transform transform, ICollection<SkeletonBone> bones)
        {
            bones.Add(new SkeletonBone
            {
                name = transform.name,
                position = transform.localPosition,
                rotation = transform.localRotation,
                scale = transform.localScale,
            });
            for (var i = 0; i < transform.childCount; i++)
            {
                AddSkeletonBoneRecursive(transform.GetChild(i), bones);
            }
        }

        private static HumanBone[] BuildHumanBones()
        {
            var bones = new List<HumanBone>();
            foreach (var kvp in BoneNameToHumanBodyBone)
            {
                // Map our node name to the Unity bone transform name
                // The transform names match our CreateBone names but with PascalCase
                var transformName = ToPascalCase(kvp.Key);
                bones.Add(new HumanBone
                {
                    boneName = transformName,
                    humanName = HumanTrait.BoneName[(int)kvp.Value],
                    limit = new HumanLimit { useDefaultValues = true },
                });
            }
            return bones.ToArray();
        }

        private static string ToPascalCase(string camelCase)
        {
            if (string.IsNullOrEmpty(camelCase)) return camelCase;
            return char.ToUpperInvariant(camelCase[0]) + camelCase.Substring(1);
        }

        private static string NormalizeMusclePropertyName(string name)
        {
            return name.Trim().ToLowerInvariant().Replace(".", "_").Replace(" ", ".").Replace("-", "_");
        }

        private static Dictionary<string, string> ParseArguments(IEnumerable<string> rawArgs)
        {
            var parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string currentKey = null;
            foreach (var token in rawArgs)
            {
                if (token.StartsWith("--", StringComparison.Ordinal))
                {
                    currentKey = token.Substring(2);
                    parsed[currentKey] = string.Empty;
                    continue;
                }
                if (currentKey == null) continue;
                parsed[currentKey] = token;
                currentKey = null;
            }
            return parsed;
        }

        private static string RequireArgument(Dictionary<string, string> args, string key)
        {
            if (!args.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException($"Missing required argument '--{key}'.");
            return value;
        }

        // Internal types
        private sealed class ExportRig
        {
            public GameObject root;
            public Avatar avatar;
            public Animator animator;
            public HumanPoseHandler poseHandler;
        }

        private sealed class GltfDocument
        {
            public GltfAsset asset;
            public string[] extensionsUsed;
            public int scene;
            public GltfScene[] scenes;
            public GltfNode[] nodes;
            public GltfBuffer[] buffers;
            public GltfBufferView[] bufferViews;
            public GltfAccessor[] accessors;
            public GltfAnimation[] animations;
            public Dictionary<string, object> extensions;
        }

        private sealed class GltfAsset { public string version; public string generator; }
        private sealed class GltfScene { public int[] nodes; }
        private sealed class GltfNode
        {
            public string name;
            public int[] children;
            public float[] rotation;
            public float[] translation;
        }
        private sealed class GltfBuffer { public int byteLength; }
        private sealed class GltfBufferView { public int buffer; public int byteOffset; public int byteLength; }
        private sealed class GltfAccessor
        {
            public int bufferView;
            public int componentType;
            public int count;
            public string type;
            public float[] min;
            public float[] max;
        }
        private sealed class GltfAnimation
        {
            public string name;
            public GltfAnimationChannel[] channels;
            public GltfAnimationSampler[] samplers;
        }
        private sealed class GltfAnimationChannel
        {
            public int sampler;
            public GltfAnimationChannelTarget target;
        }
        private sealed class GltfAnimationChannelTarget { public int node; public string path; }
        private sealed class GltfAnimationSampler { public int input; public int output; public string interpolation; }
    }
}
