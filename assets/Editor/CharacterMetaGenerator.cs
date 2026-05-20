using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;

namespace NikoF.AssetTools
{
    public static class CharacterMetaGenerator
    {
        public static void RunFromCommandLine()
        {
            try
            {
                var assetRelativePath = GetRequiredArgument("--asset-relative-path");
                var normalizedProjectPath = NormalizeProjectAssetPath(assetRelativePath);
                var absolutePath = Path.GetFullPath(normalizedProjectPath);

                if (!Directory.Exists(absolutePath) && !File.Exists(absolutePath))
                {
                    throw new DirectoryNotFoundException($"Asset path does not exist: {assetRelativePath}");
                }

                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);

                foreach (var importPath in EnumerateImportPaths(normalizedProjectPath))
                {
                    AssetDatabase.ImportAsset(importPath, ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
                }

                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);

                Console.WriteLine($"Generated Unity metadata for {normalizedProjectPath}");
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception.ToString());
                EditorApplication.Exit(1);
                return;
            }

            EditorApplication.Exit(0);
        }

        private static IEnumerable<string> EnumerateImportPaths(string rootProjectPath)
        {
            var absoluteRoot = Path.GetFullPath(rootProjectPath);
            var importPaths = new List<string> { rootProjectPath };

            if (Directory.Exists(absoluteRoot))
            {
                importPaths.AddRange(
                    Directory.EnumerateDirectories(absoluteRoot, "*", SearchOption.AllDirectories)
                        .Select(ToProjectAssetPath)
                        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase));

                importPaths.AddRange(
                    Directory.EnumerateFiles(absoluteRoot, "*", SearchOption.AllDirectories)
                        .Where(path => !path.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
                        .Select(ToProjectAssetPath)
                        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase));
            }

            return importPaths.Distinct(StringComparer.OrdinalIgnoreCase);
        }

        private static string NormalizeProjectAssetPath(string candidatePath)
        {
            var normalized = candidatePath.Replace('\\', '/').Trim();

            if (normalized.StartsWith("./", StringComparison.Ordinal))
            {
                normalized = normalized.Substring(2);
            }

            if (normalized.StartsWith("assets/", StringComparison.OrdinalIgnoreCase))
            {
                return "Assets/" + normalized.Substring("assets/".Length);
            }

            if (string.Equals(normalized, "assets", StringComparison.OrdinalIgnoreCase))
            {
                return "Assets";
            }

            if (normalized.StartsWith("Assets/", StringComparison.Ordinal))
            {
                return normalized;
            }

            if (string.Equals(normalized, "Assets", StringComparison.Ordinal))
            {
                return normalized;
            }

            throw new ArgumentException($"Expected a project asset path under Assets/. Received: {candidatePath}");
        }

        private static string ToProjectAssetPath(string absolutePath)
        {
            var projectRoot = Path.GetFullPath(Directory.GetCurrentDirectory());
            var normalizedRoot = projectRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var normalizedAbsolutePath = Path.GetFullPath(absolutePath);

            if (!normalizedAbsolutePath.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Path is outside the project root: {absolutePath}");
            }

            var relativePath = normalizedAbsolutePath.Substring(normalizedRoot.Length).Replace('\\', '/');
            return NormalizeProjectAssetPath(relativePath);
        }

        private static string GetRequiredArgument(string name)
        {
            var arguments = Environment.GetCommandLineArgs();

            for (var index = 0; index < arguments.Length - 1; index += 1)
            {
                if (string.Equals(arguments[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    var value = arguments[index + 1]?.Trim();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        return value;
                    }

                    break;
                }
            }

            throw new ArgumentException($"Missing required command-line argument {name}.");
        }
    }
}