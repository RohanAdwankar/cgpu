from openai import OpenAI

# Point the client to the local cgpu serve instance
# The API key is required by the SDK but ignored by the server
client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="unused"
)

try:
    print("Sending request to cgpu serve...")
    response = client.responses.create(
        model="gemini-2.0-flash",
        instructions="You are a coding assistant that talks like a pirate.",
        input="How do I check if a Python object is an instance of a class?",
    )

    print("\nResponse received:")
    print("-" * 20)
    print(response.output_text)
    print("-" * 20)

except Exception as e:
    print(f"\nError: {e}")
    print("\nMake sure 'cgpu serve' is running in another terminal.")
