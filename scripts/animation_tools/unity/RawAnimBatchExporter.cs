using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace NikoF.AnimationTools
{
    public static class RawAnimBatchExporter
    {
        private const string RuntimeSchemaVersion = "1.0.0";
        private const string RuntimeKind = "normalized_humanoid_animation_clip";
        private const string SemanticAssetCandidateKind = "semantic_animation_asset_candidate";
        private const string SharedScope = "shared";
        private const string CandidateStage = "generated_candidate";
        private const string PromotionStatus = "not_promoted";
        private const string RetargetProfile = "shared_humanoid_muscle_v1";
        private const int DefaultFadeInMs = 200;
        private const int DefaultFadeOutMs = 200;
        private const float InPlaceHorizontalDriftThreshold = 0.1f;
        private const float ValueQuantizationFactor = 1000000f;
        private const float LeftLowerArmFlexRadians = 0.9f;
        private const float RightLowerArmFlexRadians = 0.9f;
        private const float LeftLowerArmTwistRadians = 0.2f;
        private const float RightLowerArmTwistRadians = -0.2f;
        private const string PunchBoneComparisonSemanticId = "gesture.punch.once";

        private static bool IsIdleBoneComparisonSemanticId(string semanticId)
        {
            return semanticId.StartsWith("idle", StringComparison.Ordinal);
        }

        public static void RunFromCommandLine()
        {
            var args = ParseArguments(Environment.GetCommandLineArgs());

            var semanticId = RequireArgument(args, "semantic-id");
            var repoRoot = RequireArgument(args, "repo-root");
            var sourceRepoPath = RequireArgument(args, "source-repo-path");
            var sourceAssetPath = RequireArgument(args, "source-asset-path");
            var stagedSidecarOutput = RequireArgument(args, "staged-sidecar-output");
            var semanticAssetOutput = RequireArgument(args, "semantic-asset-output");
            var runtimeOutput = RequireArgument(args, "runtime-output");

            AssetDatabase.Refresh();

            // For FBX files, ensure the model is imported as Humanoid so we get an Avatar
            EnsureHumanoidImportSettings(sourceAssetPath);

            var clip = LoadAnimationClip(sourceAssetPath);
            if (clip == null)
            {
                throw new InvalidOperationException($"Unable to load AnimationClip at asset path '{sourceAssetPath}'.");
            }

            var runtimeAssetRepoPath = ToRepoRelativePath(runtimeOutput, repoRoot);
            var semanticAssetRepoPath = ToRepoRelativePath(semanticAssetOutput, repoRoot);
            var stagedSidecarRepoPath = ToRepoRelativePath(stagedSidecarOutput, repoRoot);

            var clipSettings = AnimationUtility.GetAnimationClipSettings(clip);
            var frameRate = Mathf.Max(1, Mathf.RoundToInt(clip.frameRate));
            var durationSeconds = Mathf.Max(0f, clip.length);
            var durationMs = Mathf.RoundToInt(durationSeconds * 1000f);
            var sampleCount = Mathf.Max(2, Mathf.RoundToInt(durationSeconds * frameRate) + 1);
            var times = BuildSampleTimes(durationSeconds, frameRate, sampleCount);

            var bindings = AnimationUtility.GetCurveBindings(clip)
                .OrderBy(binding => binding.path, StringComparer.Ordinal)
                .ThenBy(binding => binding.propertyName, StringComparer.Ordinal)
                .ToArray();

            var channels = new List<RuntimeChannelDocument>(bindings.Length);
            float[] rootX = null;
            float[] rootZ = null;

            foreach (var binding in bindings)
            {
                var curve = AnimationUtility.GetEditorCurve(clip, binding);
                if (curve == null)
                {
                    continue;
                }

                var samples = new float[times.Length];
                var minValue = float.PositiveInfinity;
                var maxValue = float.NegativeInfinity;

                for (var index = 0; index < times.Length; index += 1)
                {
                    var sample = Quantize(curve.Evaluate(times[index]));
                    samples[index] = sample;
                    minValue = Mathf.Min(minValue, sample);
                    maxValue = Mathf.Max(maxValue, sample);
                }

                if (binding.propertyName == "RootT.x")
                {
                    rootX = samples;
                }
                else if (binding.propertyName == "RootT.z")
                {
                    rootZ = samples;
                }

                channels.Add(new RuntimeChannelDocument
                {
                    name = binding.propertyName,
                    normalized_name = NormalizeChannelName(binding.propertyName),
                    binding_path = string.IsNullOrWhiteSpace(binding.path) ? string.Empty : binding.path,
                    channel_space = ClassifyChannelSpace(binding.propertyName),
                    group = ClassifyGroup(binding.propertyName),
                    value_kind = "float",
                    min_value = Quantize(minValue),
                    max_value = Quantize(maxValue),
                    samples = samples,
                });
            }

            AddDerivedElbowFlexChannels(channels);
            AddDerivedLowerArmRotationHintChannels(channels);
            var boneTransformComparison = BuildBoneTransformComparison(semanticId, channels, times, clip, sourceAssetPath);

            var playbackMode = DeterminePlaybackMode(semanticId, clipSettings.loopTime, channels);
            var rootMotion = DetermineRootMotion(rootX, rootZ);
            var motionProfile = ResolveMotionProfile(semanticId);
            var exportAudit = BuildExportAudit(semanticId, channels, boneTransformComparison);

            var runtimeDocument = new RuntimeAnimationDocument
            {
                schema_version = RuntimeSchemaVersion,
                kind = RuntimeKind,
                stage = CandidateStage,
                promotion_status = PromotionStatus,
                semantic_id = semanticId,
                scope = SharedScope,
                channel_space = "unity_humanoid_muscle",
                source = new RuntimeSourceDocument
                {
                    kind = "unity_text_animation_clip",
                    path = sourceRepoPath,
                    importer = "unity_batchmode_temp_project",
                    source_asset_path = sourceAssetPath,
                },
                playback = new RuntimePlaybackDocument
                {
                    mode = playbackMode,
                    loop = string.Equals(playbackMode, "loop", StringComparison.Ordinal),
                    sample_rate = frameRate,
                    duration_ms = durationMs,
                    sample_count = sampleCount,
                    root_motion = rootMotion,
                },
                sampling = new RuntimeSamplingDocument
                {
                    times_s = times.Select(Quantize).ToArray(),
                },
                export_audit = exportAudit,
                motion_profile = motionProfile,
                summary = new RuntimeSummaryDocument
                {
                    channel_count = channels.Count,
                    animated_groups = channels.Select(channel => channel.group).Distinct(StringComparer.Ordinal).ToArray(),
                },
                channels = channels.ToArray(),
            };

            var semanticAssetDocument = new SemanticAnimationAssetCandidateDocument
            {
                dsl_version = RuntimeSchemaVersion,
                kind = SemanticAssetCandidateKind,
                stage = CandidateStage,
                promotion_status = PromotionStatus,
                semantic_id = semanticId,
                scope = SharedScope,
                @base = new SemanticAssetBaseDocument
                {
                    clip_ref = new SemanticAssetClipReferenceDocument
                    {
                        path = runtimeAssetRepoPath,
                    },
                    playback = playbackMode,
                    body_scope = "full_body",
                    root_motion = rootMotion,
                    timing = new SemanticAssetTimingDocument
                    {
                        duration_ms = durationMs,
                        fade_in_ms = DefaultFadeInMs,
                        fade_out_ms = DefaultFadeOutMs,
                    },
                    retarget_profile = RetargetProfile,
                },
                layers = new SemanticAssetLayersDocument
                {
                    speech = new SemanticAssetLayerSupportDocument { supported = false },
                    expression = new SemanticAssetLayerSupportDocument { supported = false },
                },
                fallback = new SemanticAssetFallbackDocument
                {
                    semantic_id = semanticId,
                },
                provenance = new SemanticAssetProvenanceDocument
                {
                    raw_source_path = sourceRepoPath,
                    staged_sidecar_path = stagedSidecarRepoPath,
                    generated_runtime_path = runtimeAssetRepoPath,
                    exporter = "unity_batch_raw_anim_exporter",
                },
            };

            var stagedSidecarDocument = new StagedSidecarDocument
            {
                semantic_id = semanticId,
                stage = "staged_raw_unity_source",
                approved_for_shared_library = false,
                promotion_status = PromotionStatus,
                source = new StagedSidecarSourceDocument
                {
                    kind = "unity_text_animation_clip",
                    path = sourceRepoPath,
                    provenance = "raw_source_asset",
                },
                unity_clip = new StagedSidecarClipDocument
                {
                    name = clip.name,
                    sample_rate = frameRate,
                    start_time = 0f,
                    stop_time = Quantize(durationSeconds),
                    loop_time = clipSettings.loopTime ? 1f : 0f,
                },
            };

            WriteJson(runtimeOutput, runtimeDocument);
            WriteJson(semanticAssetOutput, semanticAssetDocument);
            WriteJson(stagedSidecarOutput, stagedSidecarDocument);

            Debug.Log($"Exported {semanticId} to {runtimeOutput}");
            Debug.Log($"Wrote semantic candidate {semanticAssetOutput}");
            Debug.Log($"Wrote staged sidecar {stagedSidecarOutput}");
            EditorApplication.Exit(0);
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

                if (currentKey == null)
                {
                    continue;
                }

                parsed[currentKey] = token;
                currentKey = null;
            }

            return parsed;
        }

        private static void EnsureHumanoidImportSettings(string assetPath)
        {
            if (!assetPath.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var importer = AssetImporter.GetAtPath(assetPath) as ModelImporter;
            if (importer == null)
            {
                return;
            }

            if (importer.animationType == ModelImporterAnimationType.Human)
            {
                return; // Already humanoid
            }

            importer.animationType = ModelImporterAnimationType.Human;
            importer.SaveAndReimport();
            AssetDatabase.Refresh();
        }

        private static AnimationClip LoadAnimationClip(string assetPath)
        {
            // Direct .anim clip load
            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath);
            if (clip != null)
            {
                return clip;
            }

            // FBX/model: clips are sub-assets — load all and find the real one
            var allAssets = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            if (allAssets == null || allAssets.Length == 0)
            {
                return null;
            }

            AnimationClip bestClip = null;
            foreach (var asset in allAssets)
            {
                var subClip = asset as AnimationClip;
                if (subClip == null) continue;
                // Skip Unity's internal preview clips
                if (subClip.name.StartsWith("__preview__", StringComparison.Ordinal)) continue;
                bestClip = subClip;
                break;
            }

            return bestClip;
        }

        private static string RequireArgument(Dictionary<string, string> args, string key)
        {
            if (!args.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
            {
                throw new InvalidOperationException($"Missing required argument '--{key}'.");
            }

            return value;
        }

        private static string ToRepoRelativePath(string absolutePath, string repoRoot)
        {
            return Path.GetRelativePath(repoRoot, absolutePath).Replace('\\', '/');
        }

        private static float[] BuildSampleTimes(float durationSeconds, int frameRate, int sampleCount)
        {
            var times = new float[sampleCount];
            for (var index = 0; index < sampleCount; index += 1)
            {
                if (index == sampleCount - 1)
                {
                    times[index] = durationSeconds;
                    continue;
                }

                times[index] = index / (float)frameRate;
            }

            return times;
        }

        private static string DeterminePlaybackMode(string semanticId, bool loopTime, IReadOnlyCollection<RuntimeChannelDocument> channels)
        {
            if (loopTime || semanticId.StartsWith("idle.", StringComparison.Ordinal) || semanticId.EndsWith(".loop", StringComparison.Ordinal))
            {
                return "loop";
            }

            return channels.Count > 0 ? "oneshot" : "loop";
        }

        private static string DetermineRootMotion(float[] rootX, float[] rootZ)
        {
            if (rootX == null || rootZ == null || rootX.Length == 0 || rootZ.Length == 0)
            {
                return "in_place";
            }

            var startX = rootX[0];
            var startZ = rootZ[0];
            var maxHorizontalDrift = 0f;

            for (var index = 0; index < rootX.Length; index += 1)
            {
                var deltaX = rootX[index] - startX;
                var deltaZ = rootZ[index] - startZ;
                maxHorizontalDrift = Mathf.Max(maxHorizontalDrift, Mathf.Sqrt((deltaX * deltaX) + (deltaZ * deltaZ)));
            }

            return maxHorizontalDrift <= InPlaceHorizontalDriftThreshold ? "in_place" : "driven";
        }

        private static void AddDerivedElbowFlexChannels(List<RuntimeChannelDocument> channels)
        {
            AddDerivedElbowFlexChannel(
                channels,
                sourceNormalizedName: "left.forearm.stretch",
                derivedName: "Left Elbow Flex",
                derivedNormalizedName: "left.elbow.flex");
            AddDerivedElbowFlexChannel(
                channels,
                sourceNormalizedName: "right.forearm.stretch",
                derivedName: "Right Elbow Flex",
                derivedNormalizedName: "right.elbow.flex");
        }

        private static void AddDerivedElbowFlexChannel(
            List<RuntimeChannelDocument> channels,
            string sourceNormalizedName,
            string derivedName,
            string derivedNormalizedName)
        {
            if (channels.Any(channel => string.Equals(channel.normalized_name, derivedNormalizedName, StringComparison.Ordinal)))
            {
                return;
            }

            var sourceChannel = channels.FirstOrDefault(channel => string.Equals(channel.normalized_name, sourceNormalizedName, StringComparison.Ordinal));
            if (sourceChannel?.samples == null || sourceChannel.samples.Length == 0)
            {
                return;
            }

            var derivedSamples = new float[sourceChannel.samples.Length];
            var minValue = float.PositiveInfinity;
            var maxValue = float.NegativeInfinity;

            for (var index = 0; index < sourceChannel.samples.Length; index += 1)
            {
                var derivedSample = Quantize(Mathf.Max(0f, 1f - sourceChannel.samples[index]));
                derivedSamples[index] = derivedSample;
                minValue = Mathf.Min(minValue, derivedSample);
                maxValue = Mathf.Max(maxValue, derivedSample);
            }

            if (maxValue <= 0f)
            {
                return;
            }

            channels.Add(new RuntimeChannelDocument
            {
                name = derivedName,
                normalized_name = derivedNormalizedName,
                binding_path = string.Empty,
                channel_space = "derived_humanoid_hint",
                group = sourceChannel.group,
                value_kind = "float",
                min_value = Quantize(minValue),
                max_value = Quantize(maxValue),
                samples = derivedSamples,
            });
        }

        private static void AddDerivedLowerArmRotationHintChannels(List<RuntimeChannelDocument> channels)
        {
            AddDerivedLowerArmRotationHintChannel(
                channels,
                flexNormalizedName: "left.elbow.flex",
                twistNormalizedName: "left.forearm.twist.in_out",
                normalizedNamePrefix: "left.lower_arm.rotation",
                displayNamePrefix: "Left LowerArm Rotation",
                flexRadiansScale: LeftLowerArmFlexRadians,
                twistRadiansScale: LeftLowerArmTwistRadians);
            AddDerivedLowerArmRotationHintChannel(
                channels,
                flexNormalizedName: "right.elbow.flex",
                twistNormalizedName: "right.forearm.twist.in_out",
                normalizedNamePrefix: "right.lower_arm.rotation",
                displayNamePrefix: "Right LowerArm Rotation",
                flexRadiansScale: RightLowerArmFlexRadians,
                twistRadiansScale: RightLowerArmTwistRadians);
        }

        private static void AddDerivedLowerArmRotationHintChannel(
            List<RuntimeChannelDocument> channels,
            string flexNormalizedName,
            string twistNormalizedName,
            string normalizedNamePrefix,
            string displayNamePrefix,
            float flexRadiansScale,
            float twistRadiansScale)
        {
            if (channels.Any(channel => string.Equals(channel.normalized_name, normalizedNamePrefix + ".x", StringComparison.Ordinal)))
            {
                return;
            }

            var flexChannel = channels.FirstOrDefault(channel => string.Equals(channel.normalized_name, flexNormalizedName, StringComparison.Ordinal));
            var twistChannel = channels.FirstOrDefault(channel => string.Equals(channel.normalized_name, twistNormalizedName, StringComparison.Ordinal));
            if (flexChannel?.samples == null || twistChannel?.samples == null)
            {
                return;
            }

            var sampleCount = Math.Min(flexChannel.samples.Length, twistChannel.samples.Length);
            if (sampleCount == 0)
            {
                return;
            }

            var xSamples = new float[sampleCount];
            var ySamples = new float[sampleCount];
            var zSamples = new float[sampleCount];
            var wSamples = new float[sampleCount];

            for (var index = 0; index < sampleCount; index += 1)
            {
                var flexRadians = flexChannel.samples[index] * flexRadiansScale;
                var twistRadians = twistChannel.samples[index] * twistRadiansScale;
                var rotation = Quaternion.Euler(
                    flexRadians * Mathf.Rad2Deg,
                    twistRadians * Mathf.Rad2Deg,
                    0f);

                xSamples[index] = Quantize(rotation.x);
                ySamples[index] = Quantize(rotation.y);
                zSamples[index] = Quantize(rotation.z);
                wSamples[index] = Quantize(rotation.w);
            }

            AddDerivedComponentChannel(channels, displayNamePrefix, normalizedNamePrefix, "x", flexChannel.group, xSamples);
            AddDerivedComponentChannel(channels, displayNamePrefix, normalizedNamePrefix, "y", flexChannel.group, ySamples);
            AddDerivedComponentChannel(channels, displayNamePrefix, normalizedNamePrefix, "z", flexChannel.group, zSamples);
            AddDerivedComponentChannel(channels, displayNamePrefix, normalizedNamePrefix, "w", flexChannel.group, wSamples);
        }

        private static RuntimeBoneTransformComparisonDocument BuildBoneTransformComparison(
            string semanticId,
            IReadOnlyList<RuntimeChannelDocument> channels,
            IReadOnlyList<float> times,
            AnimationClip clip,
            string sourceAssetPath)
        {
            if (!ShouldExportBoneTransformComparison(semanticId))
            {
                return null;
            }

            var sampledMuscleChannels = ResolveHumanoidMuscleChannels(channels);

            // If no humanoid muscle channels (e.g. FBX with generic transform bindings),
            // use the FBX model's own Avatar and sample via clip playback on the source rig.
            if (sampledMuscleChannels.Length == 0)
            {
                return BuildBoneTransformComparisonFromFbxClipSampling(semanticId, times, clip, sourceAssetPath);
            }
            var comparisonDefinitions = GetPunchBoneComparisonDefinitions();
            var rig = CreatePunchComparisonRig();

            // Resolve per-frame body position from RootT channels (critical for correct muscle-to-bone mapping)
            var rootTxChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "roott_x", StringComparison.Ordinal));
            var rootTyChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "roott_y", StringComparison.Ordinal));
            var rootTzChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "roott_z", StringComparison.Ordinal));

            // Resolve per-frame body rotation from RootQ channels
            var rootQxChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "rootq_x", StringComparison.Ordinal));
            var rootQyChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "rootq_y", StringComparison.Ordinal));
            var rootQzChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "rootq_z", StringComparison.Ordinal));
            var rootQwChannel = channels.FirstOrDefault(c => string.Equals(c.normalized_name, "rootq_w", StringComparison.Ordinal));

            try
            {
                var pose = new HumanPose
                {
                    bodyPosition = Vector3.zero,
                    bodyRotation = Quaternion.identity,
                    muscles = new float[HumanTrait.MuscleCount],
                };

                var comparisonBones = comparisonDefinitions
                    .Select(definition => new RuntimeBoneRotationComparisonBoneDocument
                    {
                        name = definition.name,
                        human_body_bone = definition.humanBodyBone.ToString(),
                        group = definition.group,
                        muscle_channels = definition.muscleChannels,
                        local_rotation_samples = new RuntimeQuaternionComponentSamplesDocument
                        {
                            x = new float[times.Count],
                            y = new float[times.Count],
                            z = new float[times.Count],
                            w = new float[times.Count],
                        },
                    })
                    .ToArray();

                // Hips position samples (captured from Animator after pose application)
                var hipsPositionSamples = new RuntimePositionComponentSamplesDocument
                {
                    x = new float[times.Count],
                    y = new float[times.Count],
                    z = new float[times.Count],
                };

                // Foot world positions per frame (for foot-anchoring post-process)
                var footCenterXPerFrame = new float[times.Count];
                var footCenterYPerFrame = new float[times.Count];
                var footCenterZPerFrame = new float[times.Count];

                for (var sampleIndex = 0; sampleIndex < times.Count; sampleIndex += 1)
                {
                    Array.Clear(pose.muscles, 0, pose.muscles.Length);

                    foreach (var sampledMuscleChannel in sampledMuscleChannels)
                    {
                        pose.muscles[sampledMuscleChannel.muscleIndex] = sampledMuscleChannel.channel.samples[sampleIndex];
                    }

                    // Set per-frame body position from RootT channels
                    pose.bodyPosition = new Vector3(
                        rootTxChannel?.samples != null && sampleIndex < rootTxChannel.samples.Length ? rootTxChannel.samples[sampleIndex] : 0f,
                        rootTyChannel?.samples != null && sampleIndex < rootTyChannel.samples.Length ? rootTyChannel.samples[sampleIndex] : 0f,
                        rootTzChannel?.samples != null && sampleIndex < rootTzChannel.samples.Length ? rootTzChannel.samples[sampleIndex] : 0f);

                    // Set per-frame body rotation from RootQ channels
                    if (rootQxChannel?.samples != null && rootQyChannel?.samples != null &&
                        rootQzChannel?.samples != null && rootQwChannel?.samples != null &&
                        sampleIndex < rootQxChannel.samples.Length)
                    {
                        pose.bodyRotation = new Quaternion(
                            rootQxChannel.samples[sampleIndex],
                            rootQyChannel.samples[sampleIndex],
                            rootQzChannel.samples[sampleIndex],
                            rootQwChannel.samples[sampleIndex]);
                    }
                    else
                    {
                        pose.bodyRotation = Quaternion.identity;
                    }

                    rig.poseHandler.SetHumanPose(ref pose);

                    // Capture hips local position and foot world positions for anchoring
                    var hipsTransform = rig.animator.GetBoneTransform(HumanBodyBones.Hips);
                    if (hipsTransform != null)
                    {
                        hipsPositionSamples.x[sampleIndex] = Quantize(hipsTransform.localPosition.x);
                        hipsPositionSamples.y[sampleIndex] = Quantize(hipsTransform.localPosition.y);
                        hipsPositionSamples.z[sampleIndex] = Quantize(hipsTransform.localPosition.z);
                    }

                    // Record foot world positions for foot-anchoring post-process
                    var leftFootTransform = rig.animator.GetBoneTransform(HumanBodyBones.LeftFoot);
                    var rightFootTransform = rig.animator.GetBoneTransform(HumanBodyBones.RightFoot);
                    if (leftFootTransform != null && rightFootTransform != null)
                    {
                        var footCenter = (leftFootTransform.position + rightFootTransform.position) * 0.5f;
                        footCenterXPerFrame[sampleIndex] = footCenter.x;
                        footCenterYPerFrame[sampleIndex] = Mathf.Min(leftFootTransform.position.y, rightFootTransform.position.y);
                        footCenterZPerFrame[sampleIndex] = footCenter.z;
                    }

                    for (var boneIndex = 0; boneIndex < comparisonDefinitions.Length; boneIndex += 1)
                    {
                        var localRotation = SampleLocalRotation(rig.animator, comparisonDefinitions[boneIndex].humanBodyBone);
                        var rotationSamples = comparisonBones[boneIndex].local_rotation_samples;

                        rotationSamples.x[sampleIndex] = Quantize(localRotation.x);
                        rotationSamples.y[sampleIndex] = Quantize(localRotation.y);
                        rotationSamples.z[sampleIndex] = Quantize(localRotation.z);
                        rotationSamples.w[sampleIndex] = Quantize(localRotation.w);

                        if (sampleIndex == 0)
                        {
                            comparisonBones[boneIndex].first_local_rotation = ToQuaternionDocument(localRotation);
                            continue;
                        }

                        var firstRotation = FromQuaternionDocument(comparisonBones[boneIndex].first_local_rotation);
                        var angleFromFirstFrame = Quantize(Quaternion.Angle(firstRotation, localRotation));
                        comparisonBones[boneIndex].max_angle_from_first_frame_deg = Mathf.Max(
                            comparisonBones[boneIndex].max_angle_from_first_frame_deg,
                            angleFromFirstFrame);
                    }
                }

                // Foot-anchoring post-process: offset hips position so feet stay planted
                // at the frame-0 reference position. This preserves the hip sway motion
                // (rotations are untouched) but eliminates floor-plane drift.
                var referenceFootX = footCenterXPerFrame[0];
                var referenceFootY = footCenterYPerFrame[0];
                var referenceFootZ = footCenterZPerFrame[0];

                for (var i = 0; i < times.Count; i += 1)
                {
                    var footDriftX = footCenterXPerFrame[i] - referenceFootX;
                    var footDriftY = footCenterYPerFrame[i] - referenceFootY;
                    var footDriftZ = footCenterZPerFrame[i] - referenceFootZ;

                    hipsPositionSamples.x[i] = Quantize(hipsPositionSamples.x[i] - footDriftX);
                    hipsPositionSamples.y[i] = Quantize(hipsPositionSamples.y[i] - footDriftY);
                    hipsPositionSamples.z[i] = Quantize(hipsPositionSamples.z[i] - footDriftZ);
                }

                // Assign hips position samples to the hips bone document
                for (var boneIndex = 0; boneIndex < comparisonDefinitions.Length; boneIndex += 1)
                {
                    if (comparisonDefinitions[boneIndex].humanBodyBone == HumanBodyBones.Hips)
                    {
                        comparisonBones[boneIndex].local_position_samples = hipsPositionSamples;
                        break;
                    }
                }

                foreach (var comparisonBone in comparisonBones)
                {
                    var lastSampleIndex = comparisonBone.local_rotation_samples.x.Length - 1;
                    var finalRotation = new Quaternion(
                        comparisonBone.local_rotation_samples.x[lastSampleIndex],
                        comparisonBone.local_rotation_samples.y[lastSampleIndex],
                        comparisonBone.local_rotation_samples.z[lastSampleIndex],
                        comparisonBone.local_rotation_samples.w[lastSampleIndex]);
                    comparisonBone.final_local_rotation = ToQuaternionDocument(finalRotation);
                    comparisonBone.final_angle_from_first_frame_deg = Quantize(Quaternion.Angle(
                        FromQuaternionDocument(comparisonBone.first_local_rotation),
                        finalRotation));
                }

                return new RuntimeBoneTransformComparisonDocument
                {
                    clip_gate_semantic_id = semanticId,
                    comparison_kind = ResolveBoneTransformComparisonKind(semanticId),
                    sampling_mode = "sampled_humanoid_pose_to_animator_bone_local_rotations",
                    avatar_source = "temporary_humanoid_reference_rig",
                    uses_runtime_sampling_times = true,
                    bone_count = comparisonBones.Length,
                    anchor = ResolveAnchor(semanticId),
                    bones = comparisonBones,
                };
            }
            finally
            {
                if (rig.poseHandler != null)
                {
                    rig.poseHandler.Dispose();
                }

                if (rig.avatar != null)
                {
                    UnityEngine.Object.DestroyImmediate(rig.avatar);
                }

                if (rig.root != null)
                {
                    UnityEngine.Object.DestroyImmediate(rig.root);
                }
            }
        }

        private static RuntimeBoneTransformComparisonDocument BuildBoneTransformComparisonFromFbxClipSampling(
            string semanticId,
            IReadOnlyList<float> times,
            AnimationClip clip,
            string sourceAssetPath)
        {
            // Load the FBX model prefab and its Avatar
            var allAssets = AssetDatabase.LoadAllAssetsAtPath(sourceAssetPath);
            Avatar fbxAvatar = null;
            GameObject fbxModelPrefab = null;

            foreach (var asset in allAssets)
            {
                if (asset is Avatar a && a.isValid && a.isHuman)
                {
                    fbxAvatar = a;
                }

                if (asset is GameObject go && go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
                {
                    fbxModelPrefab = go;
                }
            }

            // If no skinned mesh found, try any root GameObject from the FBX
            if (fbxModelPrefab == null)
            {
                foreach (var asset in allAssets)
                {
                    if (asset is GameObject go && go.transform.parent == null)
                    {
                        fbxModelPrefab = go;
                        break;
                    }
                }
            }

            if (fbxAvatar == null || fbxModelPrefab == null)
            {
                Debug.LogWarning($"[RawAnimBatchExporter] FBX at '{sourceAssetPath}' has no humanoid Avatar or model prefab. Falling back to empty bone comparison.");
                return null;
            }

            var instance = UnityEngine.Object.Instantiate(fbxModelPrefab);
            instance.hideFlags = HideFlags.HideAndDontSave;

            try
            {
                var animator = instance.GetComponent<Animator>();
                if (animator == null)
                {
                    animator = instance.AddComponent<Animator>();
                }

                animator.avatar = fbxAvatar;
                animator.applyRootMotion = false;
                animator.Rebind();
                animator.Update(0f);

                var comparisonDefinitions = GetPunchBoneComparisonDefinitions();
                var comparisonBones = comparisonDefinitions
                    .Select(definition => new RuntimeBoneRotationComparisonBoneDocument
                    {
                        name = definition.name,
                        human_body_bone = definition.humanBodyBone.ToString(),
                        group = definition.group,
                        muscle_channels = definition.muscleChannels,
                        local_rotation_samples = new RuntimeQuaternionComponentSamplesDocument
                        {
                            x = new float[times.Count],
                            y = new float[times.Count],
                            z = new float[times.Count],
                            w = new float[times.Count],
                        },
                    })
                    .ToArray();

                // Also collect hips position samples
                var hipsPositionSamples = new RuntimePositionComponentSamplesDocument
                {
                    x = new float[times.Count],
                    y = new float[times.Count],
                    z = new float[times.Count],
                };

                for (var sampleIndex = 0; sampleIndex < times.Count; sampleIndex += 1)
                {
                    clip.SampleAnimation(instance, times[sampleIndex]);

                    for (var boneIndex = 0; boneIndex < comparisonDefinitions.Length; boneIndex += 1)
                    {
                        var localRotation = SampleLocalRotation(animator, comparisonDefinitions[boneIndex].humanBodyBone);
                        var rotationSamples = comparisonBones[boneIndex].local_rotation_samples;

                        rotationSamples.x[sampleIndex] = Quantize(localRotation.x);
                        rotationSamples.y[sampleIndex] = Quantize(localRotation.y);
                        rotationSamples.z[sampleIndex] = Quantize(localRotation.z);
                        rotationSamples.w[sampleIndex] = Quantize(localRotation.w);

                        // Collect hips local position
                        if (comparisonDefinitions[boneIndex].humanBodyBone == HumanBodyBones.Hips)
                        {
                            var hipsTransform = animator.GetBoneTransform(HumanBodyBones.Hips);
                            if (hipsTransform != null)
                            {
                                hipsPositionSamples.x[sampleIndex] = Quantize(hipsTransform.localPosition.x);
                                hipsPositionSamples.y[sampleIndex] = Quantize(hipsTransform.localPosition.y);
                                hipsPositionSamples.z[sampleIndex] = Quantize(hipsTransform.localPosition.z);
                            }
                        }

                        if (sampleIndex == 0)
                        {
                            comparisonBones[boneIndex].first_local_rotation = ToQuaternionDocument(localRotation);
                            continue;
                        }

                        var firstRotation = FromQuaternionDocument(comparisonBones[boneIndex].first_local_rotation);
                        var angleFromFirstFrame = Quantize(Quaternion.Angle(firstRotation, localRotation));
                        comparisonBones[boneIndex].max_angle_from_first_frame_deg = Mathf.Max(
                            comparisonBones[boneIndex].max_angle_from_first_frame_deg,
                            angleFromFirstFrame);
                    }
                }

                // Assign hips position samples
                for (var boneIndex = 0; boneIndex < comparisonDefinitions.Length; boneIndex += 1)
                {
                    if (comparisonDefinitions[boneIndex].humanBodyBone == HumanBodyBones.Hips)
                    {
                        comparisonBones[boneIndex].local_position_samples = hipsPositionSamples;
                        break;
                    }
                }

                foreach (var comparisonBone in comparisonBones)
                {
                    var lastSampleIndex = comparisonBone.local_rotation_samples.x.Length - 1;
                    var finalRotation = new Quaternion(
                        comparisonBone.local_rotation_samples.x[lastSampleIndex],
                        comparisonBone.local_rotation_samples.y[lastSampleIndex],
                        comparisonBone.local_rotation_samples.z[lastSampleIndex],
                        comparisonBone.local_rotation_samples.w[lastSampleIndex]);
                    comparisonBone.final_local_rotation = ToQuaternionDocument(finalRotation);
                    comparisonBone.final_angle_from_first_frame_deg = Quantize(Quaternion.Angle(
                        FromQuaternionDocument(comparisonBone.first_local_rotation),
                        finalRotation));
                }

                Debug.Log($"[RawAnimBatchExporter] FBX clip sampling: {comparisonBones.Length} bones, {times.Count} samples via SampleAnimation on '{sourceAssetPath}'");

                return new RuntimeBoneTransformComparisonDocument
                {
                    clip_gate_semantic_id = semanticId,
                    comparison_kind = ResolveBoneTransformComparisonKind(semanticId),
                    sampling_mode = "fbx_clip_sample_animation_to_bone_local_rotations",
                    avatar_source = "fbx_model_instance_with_humanoid_avatar",
                    uses_runtime_sampling_times = true,
                    bone_count = comparisonBones.Length,
                    anchor = ResolveAnchor(semanticId),
                    bones = comparisonBones,
                };
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        private static RuntimeExportAuditDocument BuildExportAudit(
            string semanticId,
            IReadOnlyCollection<RuntimeChannelDocument> channels,
            RuntimeBoneTransformComparisonDocument boneTransformComparison)
        {
            var rootTransformChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "root_transform", StringComparison.Ordinal));
            var humanoidMuscleChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "humanoid_muscle", StringComparison.Ordinal));
            var derivedHintChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "derived_humanoid_hint", StringComparison.Ordinal));
            var hasBoneTransformComparison = boneTransformComparison != null;

            return new RuntimeExportAuditDocument
            {
                extraction_mode = hasBoneTransformComparison
                    ? ResolveBoneTransformExtractionMode(semanticId)
                    : "curve_bindings_plus_derived_hints",
                curve_binding_channel_count = rootTransformChannelCount + humanoidMuscleChannelCount,
                humanoid_muscle_channel_count = humanoidMuscleChannelCount,
                root_transform_channel_count = rootTransformChannelCount,
                derived_hint_channel_count = derivedHintChannelCount,
                samples_humanoid_bone_transforms = hasBoneTransformComparison,
                uses_animator_get_bone_transform = hasBoneTransformComparison,
                limb_rotation_space = hasBoneTransformComparison
                    ? "comparison_metadata_contains_bone_local_rotations"
                    : (derivedHintChannelCount > 0 ? "derived_hint_not_bone_local" : "humanoid_muscle_not_bone_local"),
                lower_arm_rotation_hint_source = derivedHintChannelCount > 0
                    ? "quaternion_composed_from_elbow_flex_and_forearm_twist"
                    : string.Empty,
                recommended_next_experiment = hasBoneTransformComparison
                    ? ResolveBoneTransformRecommendedNextExperiment(semanticId)
                    : "sample Animator.GetBoneTransform(HumanBodyBones) local rotations per frame on a humanoid instance and record explicit axis-remap metadata alongside those bone-local channels",
                bone_transform_comparison = boneTransformComparison,
            };
        }

        private static bool ShouldExportBoneTransformComparison(string semanticId)
        {
            return string.Equals(semanticId, PunchBoneComparisonSemanticId, StringComparison.Ordinal)
                || IsIdleBoneComparisonSemanticId(semanticId);
        }

        private static RuntimeAnchorDocument ResolveAnchor(string semanticId)
        {
            // Standing/idle animations: feet are the fixed anchor
            if (IsIdleBoneComparisonSemanticId(semanticId) ||
                semanticId.StartsWith("stand", StringComparison.Ordinal) ||
                semanticId.StartsWith("walk", StringComparison.Ordinal) ||
                string.Equals(semanticId, PunchBoneComparisonSemanticId, StringComparison.Ordinal))
            {
                return new RuntimeAnchorDocument
                {
                    type = "feet",
                    bones = new[] { "LeftFoot", "RightFoot", "LeftToes", "RightToes" },
                };
            }

            // Hanging animations: hands are the fixed anchor
            if (semanticId.StartsWith("hang", StringComparison.Ordinal))
            {
                return new RuntimeAnchorDocument
                {
                    type = "hands",
                    bones = new[] { "LeftHand", "RightHand" },
                };
            }

            // Default: feet anchor for any unclassified animation
            return new RuntimeAnchorDocument
            {
                type = "feet",
                bones = new[] { "LeftFoot", "RightFoot", "LeftToes", "RightToes" },
            };
        }

        private static string ResolveBoneTransformComparisonKind(string semanticId)
        {
            if (string.Equals(semanticId, PunchBoneComparisonSemanticId, StringComparison.Ordinal))
            {
                return "punch_bone_local_rotation_discriminator";
            }

            if (IsIdleBoneComparisonSemanticId(semanticId))
            {
                return "idle_bone_local_rotation_reference";
            }

            return "bone_local_rotation_reference";
        }

        private static string ResolveBoneTransformExtractionMode(string semanticId)
        {
            if (string.Equals(semanticId, PunchBoneComparisonSemanticId, StringComparison.Ordinal))
            {
                return "curve_bindings_plus_derived_hints_and_punch_bone_local_comparison";
            }

            if (IsIdleBoneComparisonSemanticId(semanticId))
            {
                return "curve_bindings_plus_derived_hints_and_idle_bone_local_comparison";
            }

            return "curve_bindings_plus_derived_hints_and_bone_local_comparison";
        }

        private static string ResolveBoneTransformRecommendedNextExperiment(string semanticId)
        {
            if (string.Equals(semanticId, PunchBoneComparisonSemanticId, StringComparison.Ordinal))
            {
                return "compare gesture.punch.once muscle channels and derived hints against the sampled bone-local rotations before widening this path beyond the punch clip";
            }

            if (IsIdleBoneComparisonSemanticId(semanticId))
            {
                return $"compare {semanticId} grounded stance frames against the sampled bone-local rotations before promoting this route beyond idle clips";
            }

            return "compare sampled humanoid muscle channels and derived hints against the exported bone-local rotations before widening this route";
        }

        private static SampledMuscleChannel[] ResolveHumanoidMuscleChannels(IReadOnlyCollection<RuntimeChannelDocument> channels)
        {
            var muscleIndexByName = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var index = 0; index < HumanTrait.MuscleCount; index += 1)
            {
                muscleIndexByName[NormalizeChannelName(HumanTrait.MuscleName[index])] = index;
            }

            return channels
                .Where(channel =>
                    string.Equals(channel.channel_space, "humanoid_muscle", StringComparison.Ordinal) &&
                    channel.samples != null &&
                    muscleIndexByName.ContainsKey(channel.normalized_name))
                .Select(channel => new SampledMuscleChannel
                {
                    muscleIndex = muscleIndexByName[channel.normalized_name],
                    channel = channel,
                })
                .ToArray();
        }

        private static PunchComparisonRig CreatePunchComparisonRig()
        {
            var root = new GameObject("PunchComparisonRigRoot")
            {
                hideFlags = HideFlags.HideAndDontSave,
            };

            var hips = CreateBone(root.transform, "Hips", new Vector3(0f, 1f, 0f), Quaternion.Euler(4f, 0f, 0f));
            var spine = CreateBone(hips, "Spine", new Vector3(0f, 0.12f, -0.01f), Quaternion.Euler(3f, 0f, 0f));
            var chest = CreateBone(spine, "Chest", new Vector3(0f, 0.14f, -0.005f), Quaternion.Euler(2.5f, 0f, 0f));
            var upperChest = CreateBone(chest, "UpperChest", new Vector3(0f, 0.12f, 0.01f), Quaternion.Euler(1.5f, 0f, 0f));
            var neck = CreateBone(upperChest, "Neck", new Vector3(0f, 0.12f, 0f), Quaternion.Euler(3f, 0f, 0f));
            CreateBone(neck, "Head", new Vector3(0f, 0.12f, 0f), Quaternion.Euler(-2f, 0f, 0f));

            var leftShoulder = CreateBone(upperChest, "LeftShoulder", new Vector3(-0.07f, 0.1f, 0f), Quaternion.Euler(0f, 0f, 3f));
            var leftUpperArm = CreateBone(leftShoulder, "LeftUpperArm", new Vector3(-0.18f, 0f, 0f));
            var leftLowerArm = CreateBone(leftUpperArm, "LeftLowerArm", new Vector3(-0.28f, 0f, 0f));
            CreateBone(leftLowerArm, "LeftHand", new Vector3(-0.22f, 0f, 0f));

            var rightShoulder = CreateBone(upperChest, "RightShoulder", new Vector3(0.07f, 0.1f, 0f), Quaternion.Euler(0f, 0f, -3f));
            var rightUpperArm = CreateBone(rightShoulder, "RightUpperArm", new Vector3(0.18f, 0f, 0f));
            var rightLowerArm = CreateBone(rightUpperArm, "RightLowerArm", new Vector3(0.28f, 0f, 0f));
            CreateBone(rightLowerArm, "RightHand", new Vector3(0.22f, 0f, 0f));

            var leftUpperLeg = CreateBone(hips, "LeftUpperLeg", new Vector3(-0.09f, -0.12f, 0f));
            var leftLowerLeg = CreateBone(leftUpperLeg, "LeftLowerLeg", new Vector3(0f, -0.46f, 0f));
                var leftFoot = CreateBone(leftLowerLeg, "LeftFoot", new Vector3(0f, -0.44f, 0.08f));
                CreateBone(leftFoot, "LeftToes", new Vector3(0f, 0f, 0.14f));

            var rightUpperLeg = CreateBone(hips, "RightUpperLeg", new Vector3(0.09f, -0.12f, 0f));
            var rightLowerLeg = CreateBone(rightUpperLeg, "RightLowerLeg", new Vector3(0f, -0.46f, 0f));
                var rightFoot = CreateBone(rightLowerLeg, "RightFoot", new Vector3(0f, -0.44f, 0.08f));
                CreateBone(rightFoot, "RightToes", new Vector3(0f, 0f, 0.14f));

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
                throw new InvalidOperationException("Unable to build temporary humanoid avatar for punch bone transform comparison.");
            }

            animator.avatar = avatar;
            animator.applyRootMotion = false;
            animator.Rebind();
            animator.Update(0f);

            return new PunchComparisonRig
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
            var bone = new GameObject(boneName)
            {
                hideFlags = HideFlags.HideAndDontSave,
            }.transform;
            bone.SetParent(parent, false);
            bone.localPosition = localPosition;
            bone.localRotation = localRotation;
            bone.localScale = Vector3.one;
            return bone;
        }

        private static SkeletonBone[] BuildSkeletonBones(Transform root)
        {
            var skeletonBones = new List<SkeletonBone>();
            AddSkeletonBoneRecursive(root, skeletonBones);
            return skeletonBones.ToArray();
        }

        private static void AddSkeletonBoneRecursive(Transform transform, ICollection<SkeletonBone> skeletonBones)
        {
            skeletonBones.Add(new SkeletonBone
            {
                name = transform.name,
                position = transform.localPosition,
                rotation = transform.localRotation,
                scale = transform.localScale,
            });

            for (var childIndex = 0; childIndex < transform.childCount; childIndex += 1)
            {
                AddSkeletonBoneRecursive(transform.GetChild(childIndex), skeletonBones);
            }
        }

        private static HumanBone[] BuildHumanBones()
        {
            return new[]
            {
                CreateHumanBone("Hips", HumanBodyBones.Hips),
                CreateHumanBone("Spine", HumanBodyBones.Spine),
                CreateHumanBone("Chest", HumanBodyBones.Chest),
                CreateHumanBone("UpperChest", HumanBodyBones.UpperChest),
                CreateHumanBone("Neck", HumanBodyBones.Neck),
                CreateHumanBone("Head", HumanBodyBones.Head),
                CreateHumanBone("LeftShoulder", HumanBodyBones.LeftShoulder),
                CreateHumanBone("LeftUpperArm", HumanBodyBones.LeftUpperArm),
                CreateHumanBone("LeftLowerArm", HumanBodyBones.LeftLowerArm),
                CreateHumanBone("LeftHand", HumanBodyBones.LeftHand),
                CreateHumanBone("RightShoulder", HumanBodyBones.RightShoulder),
                CreateHumanBone("RightUpperArm", HumanBodyBones.RightUpperArm),
                CreateHumanBone("RightLowerArm", HumanBodyBones.RightLowerArm),
                CreateHumanBone("RightHand", HumanBodyBones.RightHand),
                CreateHumanBone("LeftUpperLeg", HumanBodyBones.LeftUpperLeg),
                CreateHumanBone("LeftLowerLeg", HumanBodyBones.LeftLowerLeg),
                CreateHumanBone("LeftFoot", HumanBodyBones.LeftFoot),
                CreateHumanBone("LeftToes", HumanBodyBones.LeftToes),
                CreateHumanBone("RightUpperLeg", HumanBodyBones.RightUpperLeg),
                CreateHumanBone("RightLowerLeg", HumanBodyBones.RightLowerLeg),
                CreateHumanBone("RightFoot", HumanBodyBones.RightFoot),
                CreateHumanBone("RightToes", HumanBodyBones.RightToes),
            };
        }

        private static HumanBone CreateHumanBone(string boneName, HumanBodyBones humanBodyBone)
        {
            return new HumanBone
            {
                boneName = boneName,
                humanName = HumanTrait.BoneName[(int)humanBodyBone],
                limit = new HumanLimit
                {
                    useDefaultValues = true,
                },
            };
        }

        private static Quaternion SampleLocalRotation(Animator animator, HumanBodyBones humanBodyBone)
        {
            var boneTransform = animator.GetBoneTransform(humanBodyBone);
            if (boneTransform == null)
            {
                throw new InvalidOperationException($"Temporary humanoid rig is missing mapped transform for '{humanBodyBone}'.");
            }

            return boneTransform.localRotation;
        }

        private static RuntimeQuaternionDocument ToQuaternionDocument(Quaternion quaternion)
        {
            return new RuntimeQuaternionDocument
            {
                x = Quantize(quaternion.x),
                y = Quantize(quaternion.y),
                z = Quantize(quaternion.z),
                w = Quantize(quaternion.w),
            };
        }

        private static Quaternion FromQuaternionDocument(RuntimeQuaternionDocument quaternion)
        {
            return new Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        }

        private static PunchComparisonBoneDefinition[] GetPunchBoneComparisonDefinitions()
        {
            return new[]
            {
                new PunchComparisonBoneDefinition
                {
                    name = "hips",
                    humanBodyBone = HumanBodyBones.Hips,
                    group = "torso",
                    muscleChannels = Array.Empty<string>(),
                },
                new PunchComparisonBoneDefinition
                {
                    name = "spine",
                    humanBodyBone = HumanBodyBones.Spine,
                    group = "torso",
                    muscleChannels = new[] { "spine.front_back", "spine.left_right", "spine.twist.left_right" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "chest",
                    humanBodyBone = HumanBodyBones.Chest,
                    group = "torso",
                    muscleChannels = new[] { "chest.front_back", "chest.left_right", "chest.twist.left_right" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "upperChest",
                    humanBodyBone = HumanBodyBones.UpperChest,
                    group = "torso",
                    muscleChannels = new[] { "upperchest.front_back", "upperchest.left_right", "upperchest.twist.left_right" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "neck",
                    humanBodyBone = HumanBodyBones.Neck,
                    group = "head",
                    muscleChannels = new[] { "neck.nod.down_up", "neck.tilt.left_right", "neck.turn.left_right" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "head",
                    humanBodyBone = HumanBodyBones.Head,
                    group = "head",
                    muscleChannels = new[] { "head.nod.down_up", "head.tilt.left_right", "head.turn.left_right" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftShoulder",
                    humanBodyBone = HumanBodyBones.LeftShoulder,
                    group = "upper_body",
                    muscleChannels = new[] { "left.shoulder.down_up", "left.shoulder.front_back" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftUpperArm",
                    humanBodyBone = HumanBodyBones.LeftUpperArm,
                    group = "upper_body",
                    muscleChannels = new[] { "left.arm.down_up", "left.arm.front_back", "left.arm.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftLowerArm",
                    humanBodyBone = HumanBodyBones.LeftLowerArm,
                    group = "upper_body",
                    muscleChannels = new[]
                    {
                        "left.forearm.stretch",
                        "left.forearm.twist.in_out",
                        "left.elbow.flex",
                        "left.lower_arm.rotation.x",
                        "left.lower_arm.rotation.y",
                        "left.lower_arm.rotation.z",
                        "left.lower_arm.rotation.w",
                    },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftHand",
                    humanBodyBone = HumanBodyBones.LeftHand,
                    group = "upper_body",
                    muscleChannels = new[] { "left.hand.down_up", "left.hand.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightUpperArm",
                    humanBodyBone = HumanBodyBones.RightUpperArm,
                    group = "upper_body",
                    muscleChannels = new[] { "right.arm.down_up", "right.arm.front_back", "right.arm.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightLowerArm",
                    humanBodyBone = HumanBodyBones.RightLowerArm,
                    group = "upper_body",
                    muscleChannels = new[]
                    {
                        "right.forearm.stretch",
                        "right.forearm.twist.in_out",
                        "right.elbow.flex",
                        "right.lower_arm.rotation.x",
                        "right.lower_arm.rotation.y",
                        "right.lower_arm.rotation.z",
                        "right.lower_arm.rotation.w",
                    },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightHand",
                    humanBodyBone = HumanBodyBones.RightHand,
                    group = "upper_body",
                    muscleChannels = new[] { "right.hand.down_up", "right.hand.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightShoulder",
                    humanBodyBone = HumanBodyBones.RightShoulder,
                    group = "upper_body",
                    muscleChannels = new[] { "right.shoulder.down_up", "right.shoulder.front_back" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftUpperLeg",
                    humanBodyBone = HumanBodyBones.LeftUpperLeg,
                    group = "locomotion",
                    muscleChannels = new[] { "left.upper.leg.front_back", "left.upper.leg.in_out", "left.upper.leg.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftLowerLeg",
                    humanBodyBone = HumanBodyBones.LeftLowerLeg,
                    group = "locomotion",
                    muscleChannels = new[] { "left.lower.leg.stretch", "left.lower.leg.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftFoot",
                    humanBodyBone = HumanBodyBones.LeftFoot,
                    group = "locomotion",
                    muscleChannels = new[] { "left.foot.up_down", "left.foot.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "leftToes",
                    humanBodyBone = HumanBodyBones.LeftToes,
                    group = "locomotion",
                    muscleChannels = new[] { "left.toes.up_down" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightUpperLeg",
                    humanBodyBone = HumanBodyBones.RightUpperLeg,
                    group = "locomotion",
                    muscleChannels = new[] { "right.upper.leg.front_back", "right.upper.leg.in_out", "right.upper.leg.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightLowerLeg",
                    humanBodyBone = HumanBodyBones.RightLowerLeg,
                    group = "locomotion",
                    muscleChannels = new[] { "right.lower.leg.stretch", "right.lower.leg.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightFoot",
                    humanBodyBone = HumanBodyBones.RightFoot,
                    group = "locomotion",
                    muscleChannels = new[] { "right.foot.up_down", "right.foot.twist.in_out" },
                },
                new PunchComparisonBoneDefinition
                {
                    name = "rightToes",
                    humanBodyBone = HumanBodyBones.RightToes,
                    group = "locomotion",
                    muscleChannels = new[] { "right.toes.up_down" },
                },
            };
        }

        private static void AddDerivedComponentChannel(
            List<RuntimeChannelDocument> channels,
            string displayNamePrefix,
            string normalizedNamePrefix,
            string componentName,
            string group,
            float[] samples)
        {
            var minValue = float.PositiveInfinity;
            var maxValue = float.NegativeInfinity;

            for (var index = 0; index < samples.Length; index += 1)
            {
                minValue = Mathf.Min(minValue, samples[index]);
                maxValue = Mathf.Max(maxValue, samples[index]);
            }

            channels.Add(new RuntimeChannelDocument
            {
                name = displayNamePrefix + " " + componentName.ToUpperInvariant(),
                normalized_name = normalizedNamePrefix + "." + componentName,
                binding_path = string.Empty,
                channel_space = "derived_humanoid_hint",
                group = group,
                value_kind = "quaternion_component",
                min_value = Quantize(minValue),
                max_value = Quantize(maxValue),
                samples = samples,
            });
        }

        private static RuntimeMotionProfileDocument ResolveMotionProfile(string semanticId)
        {
            if (string.Equals(semanticId, "idle.default", StringComparison.Ordinal))
            {
                return new RuntimeMotionProfileDocument
                {
                    speed_multiplier = 1.0f,
                    bob_amplitude = 0.018f,
                    secondary_bob_amplitude = 0.004f,
                    lean_amplitude = 0.018f,
                    nod_amplitude = 0.012f,
                    yaw_amplitude = 0.03f,
                };
            }

            if (string.Equals(semanticId, "listen.loop", StringComparison.Ordinal))
            {
                return new RuntimeMotionProfileDocument
                {
                    speed_multiplier = 0.85f,
                    bob_amplitude = 0.012f,
                    secondary_bob_amplitude = 0.002f,
                    lean_amplitude = 0.01f,
                    nod_amplitude = 0.01f,
                    yaw_amplitude = 0.025f,
                };
            }

            if (string.Equals(semanticId, "speak.loop", StringComparison.Ordinal))
            {
                return new RuntimeMotionProfileDocument
                {
                    speed_multiplier = 1.2f,
                    bob_amplitude = 0.014f,
                    secondary_bob_amplitude = 0.003f,
                    lean_amplitude = 0.012f,
                    nod_amplitude = 0.02f,
                    yaw_amplitude = 0.045f,
                };
            }

            return null;
        }

        private static string ClassifyChannelSpace(string attribute)
        {
            return attribute.StartsWith("Root", StringComparison.Ordinal) ? "root_transform" : "humanoid_muscle";
        }

        private static string ClassifyGroup(string attribute)
        {
            if (attribute.StartsWith("Root", StringComparison.Ordinal))
            {
                return "root";
            }

            if (attribute.StartsWith("Spine", StringComparison.Ordinal) || attribute.StartsWith("Chest", StringComparison.Ordinal) || attribute.StartsWith("UpperChest", StringComparison.Ordinal))
            {
                return "torso";
            }

            if (attribute.StartsWith("Neck", StringComparison.Ordinal) || attribute.StartsWith("Head", StringComparison.Ordinal) || attribute.Contains("Eye", StringComparison.Ordinal) || attribute.StartsWith("Jaw", StringComparison.Ordinal))
            {
                return "head";
            }

            if (attribute.StartsWith("Left", StringComparison.Ordinal) || attribute.StartsWith("Right", StringComparison.Ordinal))
            {
                if (attribute.Contains("Leg", StringComparison.Ordinal) || attribute.Contains("Foot", StringComparison.Ordinal) || attribute.Contains("Toes", StringComparison.Ordinal))
                {
                    return "locomotion";
                }

                if (attribute.Contains("Shoulder", StringComparison.Ordinal) || attribute.Contains("Arm", StringComparison.Ordinal) || attribute.Contains("Forearm", StringComparison.Ordinal) || attribute.Contains("Hand", StringComparison.Ordinal))
                {
                    return "upper_body";
                }
            }

            return "misc";
        }

        private static string NormalizeChannelName(string attribute)
        {
            return attribute
                .Trim()
                .ToLowerInvariant()
                .Replace(".", "_")
                .Replace(" ", ".")
                .Replace("-", "_");
        }

        private static float Quantize(float value)
        {
            return (float)Math.Round(value * ValueQuantizationFactor, MidpointRounding.AwayFromZero) / ValueQuantizationFactor;
        }

        private static void WriteJson<TDocument>(string outputPath, TDocument document)
        {
            var directory = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var json = JsonUtility.ToJson(document, true);
            File.WriteAllText(outputPath, json + Environment.NewLine);
        }

        [Serializable]
        private sealed class RuntimeAnimationDocument
        {
            public string schema_version;
            public string kind;
            public string stage;
            public string promotion_status;
            public string semantic_id;
            public string scope;
            public string channel_space;
            public RuntimeSourceDocument source;
            public RuntimePlaybackDocument playback;
            public RuntimeSamplingDocument sampling;
            public RuntimeExportAuditDocument export_audit;
            public RuntimeMotionProfileDocument motion_profile;
            public RuntimeSummaryDocument summary;
            public RuntimeChannelDocument[] channels;
        }

        [Serializable]
        private sealed class RuntimeSourceDocument
        {
            public string kind;
            public string path;
            public string importer;
            public string source_asset_path;
        }

        [Serializable]
        private sealed class RuntimePlaybackDocument
        {
            public string mode;
            public bool loop;
            public int sample_rate;
            public int duration_ms;
            public int sample_count;
            public string root_motion;
        }

        [Serializable]
        private sealed class RuntimeSamplingDocument
        {
            public float[] times_s;
        }

        [Serializable]
        private sealed class RuntimeExportAuditDocument
        {
            public string extraction_mode;
            public int curve_binding_channel_count;
            public int humanoid_muscle_channel_count;
            public int root_transform_channel_count;
            public int derived_hint_channel_count;
            public bool samples_humanoid_bone_transforms;
            public bool uses_animator_get_bone_transform;
            public string limb_rotation_space;
            public string lower_arm_rotation_hint_source;
            public string recommended_next_experiment;
            public RuntimeBoneTransformComparisonDocument bone_transform_comparison;
        }

        [Serializable]
        private sealed class RuntimeBoneTransformComparisonDocument
        {
            public string clip_gate_semantic_id;
            public string comparison_kind;
            public string sampling_mode;
            public string avatar_source;
            public bool uses_runtime_sampling_times;
            public int bone_count;
            public RuntimeAnchorDocument anchor;
            public RuntimeBoneRotationComparisonBoneDocument[] bones;
        }

        [Serializable]
        private sealed class RuntimeAnchorDocument
        {
            public string type;
            public string[] bones;
        }

        [Serializable]
        private sealed class RuntimeBoneRotationComparisonBoneDocument
        {
            public string name;
            public string human_body_bone;
            public string group;
            public string[] muscle_channels;
            public RuntimeQuaternionDocument first_local_rotation;
            public RuntimeQuaternionDocument final_local_rotation;
            public float max_angle_from_first_frame_deg;
            public float final_angle_from_first_frame_deg;
            public RuntimeQuaternionComponentSamplesDocument local_rotation_samples;
            public RuntimePositionComponentSamplesDocument local_position_samples;
        }

        [Serializable]
        private sealed class RuntimePositionComponentSamplesDocument
        {
            public float[] x;
            public float[] y;
            public float[] z;
        }

        [Serializable]
        private sealed class RuntimeQuaternionComponentSamplesDocument
        {
            public float[] x;
            public float[] y;
            public float[] z;
            public float[] w;
        }

        [Serializable]
        private sealed class RuntimeQuaternionDocument
        {
            public float x;
            public float y;
            public float z;
            public float w;
        }

        [Serializable]
        private sealed class RuntimeMotionProfileDocument
        {
            public float speed_multiplier;
            public float bob_amplitude;
            public float secondary_bob_amplitude;
            public float lean_amplitude;
            public float nod_amplitude;
            public float yaw_amplitude;
        }

        [Serializable]
        private sealed class RuntimeSummaryDocument
        {
            public int channel_count;
            public string[] animated_groups;
        }

        [Serializable]
        private sealed class RuntimeChannelDocument
        {
            public string name;
            public string normalized_name;
            public string binding_path;
            public string channel_space;
            public string group;
            public string value_kind;
            public float min_value;
            public float max_value;
            public float[] samples;
        }

        [Serializable]
        private sealed class SemanticAnimationAssetCandidateDocument
        {
            public string dsl_version;
            public string kind;
            public string stage;
            public string promotion_status;
            public string semantic_id;
            public string scope;
            public SemanticAssetBaseDocument @base;
            public SemanticAssetLayersDocument layers;
            public SemanticAssetFallbackDocument fallback;
            public SemanticAssetProvenanceDocument provenance;
        }

        [Serializable]
        private sealed class SemanticAssetBaseDocument
        {
            public SemanticAssetClipReferenceDocument clip_ref;
            public string playback;
            public string body_scope;
            public string root_motion;
            public SemanticAssetTimingDocument timing;
            public string retarget_profile;
        }

        [Serializable]
        private sealed class SemanticAssetClipReferenceDocument
        {
            public string path;
        }

        [Serializable]
        private sealed class SemanticAssetTimingDocument
        {
            public int duration_ms;
            public int fade_in_ms;
            public int fade_out_ms;
        }

        [Serializable]
        private sealed class SemanticAssetLayersDocument
        {
            public SemanticAssetLayerSupportDocument speech;
            public SemanticAssetLayerSupportDocument expression;
        }

        [Serializable]
        private sealed class SemanticAssetLayerSupportDocument
        {
            public bool supported;
        }

        [Serializable]
        private sealed class SemanticAssetFallbackDocument
        {
            public string semantic_id;
        }

        [Serializable]
        private sealed class SemanticAssetProvenanceDocument
        {
            public string raw_source_path;
            public string staged_sidecar_path;
            public string generated_runtime_path;
            public string exporter;
        }

        [Serializable]
        private sealed class StagedSidecarDocument
        {
            public string semantic_id;
            public string stage;
            public bool approved_for_shared_library;
            public string promotion_status;
            public StagedSidecarSourceDocument source;
            public StagedSidecarClipDocument unity_clip;
        }

        [Serializable]
        private sealed class StagedSidecarSourceDocument
        {
            public string kind;
            public string path;
            public string provenance;
        }

        [Serializable]
        private sealed class StagedSidecarClipDocument
        {
            public string name;
            public int sample_rate;
            public float start_time;
            public float stop_time;
            public float loop_time;
        }

        private sealed class SampledMuscleChannel
        {
            public int muscleIndex;
            public RuntimeChannelDocument channel;
        }

        private sealed class PunchComparisonRig
        {
            public GameObject root;
            public Avatar avatar;
            public Animator animator;
            public HumanPoseHandler poseHandler;
        }

        private sealed class PunchComparisonBoneDefinition
        {
            public string name;
            public HumanBodyBones humanBodyBone;
            public string group;
            public string[] muscleChannels;
        }
    }
}