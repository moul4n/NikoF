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

            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(sourceAssetPath);
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

            var playbackMode = DeterminePlaybackMode(semanticId, clipSettings.loopTime, channels);
            var rootMotion = DetermineRootMotion(rootX, rootZ);
            var motionProfile = ResolveMotionProfile(semanticId);
            var exportAudit = BuildExportAudit(channels);

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

        private static RuntimeExportAuditDocument BuildExportAudit(IReadOnlyCollection<RuntimeChannelDocument> channels)
        {
            var rootTransformChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "root_transform", StringComparison.Ordinal));
            var humanoidMuscleChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "humanoid_muscle", StringComparison.Ordinal));
            var derivedHintChannelCount = channels.Count(channel => string.Equals(channel.channel_space, "derived_humanoid_hint", StringComparison.Ordinal));

            return new RuntimeExportAuditDocument
            {
                extraction_mode = "curve_bindings_plus_derived_hints",
                curve_binding_channel_count = rootTransformChannelCount + humanoidMuscleChannelCount,
                humanoid_muscle_channel_count = humanoidMuscleChannelCount,
                root_transform_channel_count = rootTransformChannelCount,
                derived_hint_channel_count = derivedHintChannelCount,
                samples_humanoid_bone_transforms = false,
                uses_animator_get_bone_transform = false,
                limb_rotation_space = derivedHintChannelCount > 0 ? "derived_hint_not_bone_local" : "humanoid_muscle_not_bone_local",
                lower_arm_rotation_hint_source = derivedHintChannelCount > 0
                    ? "quaternion_composed_from_elbow_flex_and_forearm_twist"
                    : string.Empty,
                recommended_next_experiment = "sample Animator.GetBoneTransform(HumanBodyBones) local rotations per frame on a humanoid instance and record explicit axis-remap metadata alongside those bone-local channels",
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
    }
}