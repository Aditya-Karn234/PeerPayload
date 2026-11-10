// ppkeygen: creates or shows a PeerPayload Connect device identity
// (shared/include/identity.hpp). Same conventions as sender/receiver: JSON
// events on stdout (or the library callback), human text on stderr, exit 0
// on success and 1 on failure.
#include <iostream>
#include <string>

#include "engine_entry.hpp"
#include "identity.hpp"
#include "json_event.hpp"

namespace
{

void printUsage()
{
    std::cerr
        << "Usage: ppkeygen --out <dir> [--name <text>] [--force]\n"
        << "       ppkeygen --show <dir-or-certificate>\n"
        << "\n"
        << "  --out <dir>    create a device identity: <dir>/device.crt and\n"
        << "                 <dir>/device.key (Ed25519, self-signed)\n"
        << "  --name <text>  name shown to contacts in the certificate\n"
        << "                 (default \"PeerPayload device\")\n"
        << "  --force        replace an existing identity in <dir>. This changes\n"
        << "                 the device ID, so every contact has to pair again.\n"
        << "  --show <path>  print an existing identity's fingerprint\n"
        << "\n"
        << "Pass the files to sender/receiver with --cert and --key. The\n"
        << "fingerprint (certSha256) is what contacts pin or allow-list.\n"
        << "Keep device.key private: anyone who has it can act as this device.\n";
}

int fail(const std::string &reason, const std::string &message)
{
    std::cerr << message << '\n';
    JsonEvent("identity_failed").field("reason", reason).emit();
    return 1;
}

} // namespace

int runKeygenMain(int argc, char **argv)
{
    std::string outDir;
    std::string showPath;
    std::string name;
    bool force = false;

    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];

        auto value = [&](std::string &target) {
            if (++i >= argc)
                return false;
            target = argv[i];
            return true;
        };

        if (arg == "--help")
        {
            printUsage();
            return 1;
        }
        else if (arg == "--out")
        {
            if (!value(outDir))
                return fail("invalid_input", "Missing value for --out");
        }
        else if (arg == "--show")
        {
            if (!value(showPath))
                return fail("invalid_input", "Missing value for --show");
        }
        else if (arg == "--name")
        {
            if (!value(name))
                return fail("invalid_input", "Missing value for --name");

            if (name.size() > 64)
                return fail("invalid_input", "Name too long (max 64 bytes)");
        }
        else if (arg == "--force")
        {
            force = true;
        }
        else
        {
            return fail("invalid_input", "Unexpected argument: " + arg);
        }
    }

    if (outDir.empty() == showPath.empty())
    {
        printUsage();
        return fail("invalid_input", "Give exactly one of --out or --show");
    }

    if (!showPath.empty())
    {
        std::filesystem::path certPath = showPath;
        std::error_code ec;

        if (std::filesystem::is_directory(certPath, ec))
            certPath = identityPaths(certPath).certPath;

        std::string commonName;
        std::string fingerprint = certificateFileSha256(certPath, &commonName);

        if (fingerprint.empty())
            return fail("not_found", "No readable certificate at " + certPath.string());

        JsonEvent("identity")
            .field("certSha256", fingerprint)
            .field("name", commonName)
            .field("certPath", certPath.string())
            .emit();

        return 0;
    }

    std::string fingerprint;
    std::string error;
    std::error_code ec;

    if (!force && std::filesystem::exists(identityPaths(outDir).certPath, ec))
        return fail("identity_exists", "An identity already exists in " + outDir + " (use --force to replace it; this changes the device ID)");

    if (!generateIdentity(outDir, name, force, fingerprint, error))
        return fail("generate_failed", error);

    IdentityFiles files = identityPaths(outDir);

    JsonEvent("identity_created")
        .field("certSha256", fingerprint)
        .field("name", name.empty() ? std::string("PeerPayload device") : name)
        .field("certPath", files.certPath.string())
        .field("keyPath", files.keyPath.string())
        .emit();

    return 0;
}
