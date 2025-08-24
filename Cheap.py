import os
import asyncio
import re
from dotenv import load_dotenv
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent
from langchain_core.messages import HumanMessage, AIMessage, convert_to_messages

# Try to import langgraph_supervisor, with fallback if not available
try:
    from langgraph_supervisor import create_supervisor
except ImportError:
    print("Warning: langgraph_supervisor not found. Please install it: pip install langgraph_supervisor")
    create_supervisor = None

import time

# Load environment variables from .env file
load_dotenv()

# --- Utility functions for pretty printing messages ---
def pretty_print_message(message, indent=False):
    try:
        pretty_message = message.pretty_repr(html=True)
        if not indent:
            print(pretty_message)
            return
        
        indented = "\n".join("\t" + c for c in pretty_message.split("\n"))
        print(indented)
    except Exception as e:
        print(f"Error printing message: {e}")
        print(str(message))


def pretty_print_messages(update, last_message=False):
    try:
        is_subgraph = False
        if isinstance(update, tuple):
            ns, update = update
            # skip parent graph updates in the printouts
            if len(ns) == 0:
                return

            graph_id = ns[-1].split(":")[0]
            print(f"Update from subgraph {graph_id}:")
            print("\n")
            is_subgraph = True

        for node_name, node_update in update.items():
            update_label = f"Update from node {node_name}:"
            if is_subgraph:
                update_label = "\t" + update_label

            print(update_label)
            print("\n")

            if "messages" in node_update:
                messages = convert_to_messages(node_update["messages"])
                if last_message:
                    messages = messages[-1:]

                for m in messages:
                    pretty_print_message(m, indent=is_subgraph)
            print("\n")
    except Exception as e:
        print(f"Error in pretty_print_messages: {e}")


# --- Helper function to parse agent's final answer for price and URL ---
def parse_agent_output(output_content: str) -> dict:
    """
    Parses the agent's final output to extract price and URL.
    Assumes the agent's final answer will be in a structured format like:
    "Price: [extracted_price], Link: [source_url]"
    """
    try:
        price_match = re.search(r"Price: (₹?[\d,.]+)", output_content, re.IGNORECASE)
        link_match = re.search(r"Link: (https?://[^\s]+)", output_content, re.IGNORECASE)

        price = None
        link = None

        if price_match:
            price_str = re.sub(r'[₹$,]', '', price_match.group(1))
            try:
                price = float(price_str)
            except ValueError:
                price = None
        if link_match:
            link = link_match.group(1)

        return {"price": price, "link": link}
    except Exception as e:
        print(f"Error parsing agent output: {e}")
        return {"price": None, "link": None}


async def run_agent(product_query: str):
    """
    Main function to run the price comparison agent system.
    """
    try:
        # Verify API keys are present
        bright_api_token = os.getenv("BRIGHT_DATA_API_TOKEN")
        google_api_key = os.getenv("GOOGLE_API_KEY")

        if not bright_api_token:
            error_msg = "Error: Missing BRIGHT_DATA_API_TOKEN environment variable."
            print(error_msg)
            return error_msg
            
        if not google_api_key:
            error_msg = "Error: Missing GOOGLE_API_KEY environment variable."
            print(error_msg)
            return error_msg

        if create_supervisor is None:
            error_msg = "Error: langgraph_supervisor is not available. Please install it."
            print(error_msg)
            return error_msg

        # Initialize MCP client
        client = MultiServerMCPClient(
            {
                "bright_data": {
                    "command": "npx",
                    "args": ["@brightdata/mcp"],
                    "env": {
                        "API_TOKEN": bright_api_token,
                        "WEB_UNLOCKER_ZONE": os.getenv("WEB_UNLOCKER_ZONE", "unblocker"),
                        "BROWSER_ZONE": os.getenv("BROWSER_ZONE", "scraping_browser")
                    },
                    "transport": "stdio",
                },
            }
        )
        
        tools = await client.get_tools()
        agent_model = ChatGoogleGenerativeAI(model="gemini-2.0-flash", api_key=google_api_key)

        # --- Individual agents for different e-commerce platforms ---
        amazon_agent = create_react_agent(
            model=agent_model,
            tools=tools,
            prompt=(
                f"You are a web scraping agent specialized in finding product prices on Amazon.in. "
                f"Your task is to find the cheapest current price of '{product_query}' on Amazon.in. "
                "Use your 'search_engine' tool to find the product page on Amazon.in. "
                "Then, use your 'scrape_as_markdown' tool to extract the price and the direct product URL. "
                "Your final answer MUST be in the exact format: 'Price: [extracted_price], Link: [product_url]'. "
                "If not found, state 'Price: Not Found, Link: Not Found'."
            ),
            name="amazon_agent"
        )
        
        flipkart_agent = create_react_agent(
            model=agent_model,
            tools=tools,
            prompt=(
                f"You are a web scraping agent specialized in finding product prices on Flipkart.com. "
                f"Your task is to find the cheapest current price of '{product_query}' on Flipkart.com. "
                "Use your 'search_engine' tool to find the product page on Flipkart.com. "
                "Then, use your 'scrape_as_markdown' tool to extract the price and the direct product URL. "
                "Your final answer MUST be in the exact format: 'Price: [extracted_price], Link: [product_url]'. "
                "If not found, state 'Price: Not Found, Link: Not Found'."
            ),
            name="flipkart_agent"
        )
        
        shopsy_agent = create_react_agent(
            model=agent_model,
            tools=tools,
            prompt=(
                f"You are a web scraping agent specialized in finding product prices on Shopsy.com. "
                f"Your task is to find the cheapest current price of '{product_query}' on Shopsy.com. "
                "Use your 'search_engine' tool to find the product page on Shopsy.com. "
                "Then, use your 'scrape_as_markdown' tool to extract the price and the direct product URL. "
                "Your final answer MUST be in the exact format: 'Price: [extracted_price], Link: [product_url]'. "
                "If not found, state 'Price: Not Found, Link: Not Found'."
            ),
            name="shopsy_agent"
        )

        meesho_agent = create_react_agent(
            model=agent_model,
            tools=tools,
            prompt=(
                f"You are a web scraping agent specialized in finding product prices on Meesho.com. "
                f"Your task is to find the cheapest current price of '{product_query}' on Meesho.com. "
                "Use your 'search_engine' tool to find the product page on Meesho.com. "
                "Then, use your 'scrape_as_markdown' tool to extract the price and the direct product URL. "
                "Your final answer MUST be in the exact format: 'Price: [extracted_price], Link: [product_url]'. "
                "If not found, state 'Price: Not Found, Link: Not Found'."
            ),
            name="meesho_agent"
        )
        
        ajio_agent = create_react_agent(
            model=agent_model,
            tools=tools,
            prompt=(
                f"You are a web scraping agent specialized in finding product prices on Ajio.com. "
                f"Your task is to find the cheapest current price of '{product_query}' on Ajio.com. "
                "Use your 'search_engine' tool to find the product page on Ajio.com. "
                "Then, you must use your 'scrape_as_markdown' tool to extract the price and the direct product URL. "
                "Your final answer MUST be in the exact format: 'Price: [extracted_price], Link: [product_url]'. "
                "If not found, state 'Price: Not Found, Link: Not Found'."
            ),
            name="ajio_agent"
        )

        # --- Initialize the supervisor model with Gemini ---
        supervisor_model = ChatGoogleGenerativeAI(model="gemini-2.0-flash", api_key=google_api_key)

        # List of agents to be managed by the supervisor
        agents_for_supervisor = [
            amazon_agent, flipkart_agent, shopsy_agent, meesho_agent, ajio_agent
        ]
        agent_names = [
            "amazon_agent", "flipkart_agent", "shopsy_agent", "meesho_agent", "ajio_agent"
        ]

        supervisor = create_supervisor(
            model=supervisor_model,
            agents=agents_for_supervisor,
            agent_names=agent_names,
            prompt=(
                f"You are a highly intelligent supervisor managing five specialized web scraping agents for e-commerce price comparison. "
                f"Your ultimate goal is to find the cheapest price for '{product_query}' across Amazon.in, Flipkart.com, Shopsy.com, Meesho.com, and Ajio.com. "
                "You must execute the following steps **sequentially and one agent at a time**.\n\n"
                "**Workflow:**\n"
                "1.  **Initial Step (User Query -> All Agents):** You will instruct each of the five agents "
                "(amazon_agent, flipkart_agent, shopsy_agent, meesho_agent, ajio_agent) "
                f"to find the cheapest price of '{product_query}' on their respective platforms. You will pass the product query to each agent.\n"
                "2.  **Second Step (Collect & Compare Results):** Once all five agents have returned their final answers "
                "(in the format 'Price: [extracted_price], Link: [product_url]'), you must **then** collect all these results. "
                "Parse each agent's output to extract the price and link. Compare all valid prices found and identify the single cheapest price and its corresponding e-commerce site and product link.\n"
                "3.  **Final Response:** After identifying the cheapest price, you must present this as the final answer to the user. Your final response should clearly state the product, the cheapest price found, the e-commerce site where it's available, and the direct link to the product page. If no valid prices are found, state that clearly."
                "\n**Important Rules:**\n"
                "* Assign work to **one agent at a time**. Do not call agents in parallel.\n"
                "* Do not perform any web scraping or data extraction yourself. Only route and pass information.\n"
                "* Ensure the entire process is completed without asking for intermediate steps or user input.\n"
                "* The input to subsequent agents must be derived *directly* from the output of previous agents or the original query, or by combining outputs from previous agents.\n"
                "* The final response to the user must be a clear summary of the cheapest product, its price, and the link."
            ),
            add_handoff_back_messages=True,
            output_mode="full_history",
        ).compile()

        print("\n" + "="*40)
        print(f"--- Supervisor Stream Output for '{product_query}' ---")
        print("="*40)

        final_chunk = None
        
        # Try async iteration first, fall back to sync if needed
        try:
            async for chunk in supervisor.stream(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": product_query,
                        }
                    ]
                }
            ):
                pretty_print_messages(chunk, last_message=True)
                final_chunk = chunk
                # Added a small sleep to help with rate limiting
                await asyncio.sleep(2)
        except TypeError:
            # Fallback to synchronous iteration if async doesn't work
            for chunk in supervisor.stream(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": product_query,
                        }
                    ]
                }
            ):
                pretty_print_messages(chunk, last_message=True)
                final_chunk = chunk
                # Added a small sleep to help with rate limiting
                await asyncio.sleep(2)

        final_message_history = final_chunk.get("supervisor", {}).get("messages", []) if final_chunk else []
        
        if final_message_history:
            print("\n" + "="*40)
            print("--- Final Cheapest Product ---")
            print("="*40)
            final_content = final_message_history[-1].content
            print(final_content)
            return final_content
        else:
            print("No final response from the supervisor.")
            return "No response from supervisor."
    
    except Exception as e:
        error_msg = f"Error in run_agent: {str(e)}"
        print(error_msg)
        return error_msg


async def main():
    """Main entry point with error handling"""
    try:
        result = await run_agent("iPhone 15")
        print(f"\nFinal result: {result}")
    except Exception as e:
        print(f"Error in main: {str(e)}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nProcess interrupted by user.")
    except Exception as e:
        print(f"Fatal error: {str(e)}")
